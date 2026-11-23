// FreePI native executor — ported from xrouter commit 8d12fd6 and adapted to
// this fork's DefaultExecutor signature. Talks directly to api.freepi.ai; no
// local bridge process is involved. The token is injected into credentials by
// src/sse/services/auth.js from ~/.free-pi/agent/credentials.json.
//
// Auto ad impression reporting is intentionally ON (owner decision). The
// xrouter auto-ad risk (README warning about claiming impressions without a
// real viewer) therefore still applies to this provider.
import { randomUUID } from "node:crypto";
import os from "node:os";
import { DefaultExecutor } from "./default.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

// Config-driven via env so the CLI fingerprint can be aligned without a rebuild.
const CLI_VERSION = process.env.FREEPI_CLI_VERSION || "0.6.26";
const ADS_INTERVAL_MS = 60 * 1000;
const LAUNCH_HANDSHAKE_TTL_MS = 55 * 60 * 1000; // official FreePI CLI launch grace is 60m
const SETTLING_DELAY_MS = 500;
const MAX_QUEUE_SIZE = 10;
const API_BASE = "https://api.freepi.ai";

const sessionMap = new Map();
const lastImpressionMap = new Map();
const launchHandshakeMap = new Map();
const tokenQueues = new Map();

export function getSessionId(token) {
  let sid = sessionMap.get(token);
  if (!sid) {
    sid = randomUUID();
    sessionMap.set(token, sid);
  }
  return sid;
}

function resolveLocaleHeaders() {
  try {
    const o = Intl.DateTimeFormat().resolvedOptions();
    return {
      ...(o.timeZone ? { "x-client-timezone": o.timeZone } : {}),
      ...(o.locale ? { "x-client-locale": o.locale } : {}),
    };
  } catch {
    return { "x-client-timezone": "UTC", "x-client-locale": "en-US" };
  }
}

/**
 * FreePI session launch handshake: fetch banner, fire pixel, report impression,
 * then sync /me. Guarantees the token is warm/ad-satisfied for up to 60 minutes.
 */
export async function launchSessionHandshake(token, sessionId = null, proxyOptions = null) {
  if (!token || typeof token !== "string" || !token.trim()) return false;
  const cleanToken = token.trim();
  const now = Date.now();
  const lastLaunch = launchHandshakeMap.get(cleanToken) || 0;
  if (now - lastLaunch < LAUNCH_HANDSHAKE_TTL_MS) return true;

  const sid = sessionId || getSessionId(cleanToken);
  const turnId = randomUUID();
  const localeHeaders = resolveLocaleHeaders();

  try {
    const res = await proxyAwareFetch(
      `${API_BASE}/ads/next?slot=banner`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          "Content-Type": "application/json",
          "x-session-id": sid,
          "x-turn-id": turnId,
          "x-client-version": CLI_VERSION,
          "x-client-os": process.platform,
          "x-client-arch": os.arch(),
          "x-ad-trigger": "launch",
          "x-ad-context": "none",
          ...localeHeaders,
        },
        signal: AbortSignal.timeout(6000),
      },
      proxyOptions
    );
    if (res.ok) {
      const ad = await res.json().catch(() => null);
      if (ad && ad.ad_id) {
        if (ad.imp_url && typeof ad.imp_url === "string") {
          proxyAwareFetch(ad.imp_url, { method: "GET", signal: AbortSignal.timeout(4000) }, proxyOptions).catch(() => {});
        }
        await proxyAwareFetch(
          `${API_BASE}/ads/impression`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${cleanToken}`,
              "Content-Type": "application/json",
              "x-session-id": sid,
            },
            body: JSON.stringify({
              ad_id: ad.ad_id,
              click_token: ad.click_token,
              imp_fired: Boolean(ad.imp_url),
            }),
            signal: AbortSignal.timeout(5000),
          },
          proxyOptions
        );
      }
    }
    await proxyAwareFetch(
      `${API_BASE}/me`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          "Content-Type": "application/json",
          "x-session-id": sid,
        },
        signal: AbortSignal.timeout(5000),
      },
      proxyOptions
    ).catch(() => {});

    launchHandshakeMap.set(cleanToken, Date.now());
    lastImpressionMap.set(cleanToken, Date.now());
    return true;
  } catch {
    return false;
  }
}

/** Periodic ad impression reporting during active conversation turns. */
async function fireAdCycle(token, sessionId, turnId, proxyOptions) {
  if (!token || typeof token !== "string" || !token.trim()) return;
  const cleanToken = token.trim();
  const localeHeaders = resolveLocaleHeaders();
  try {
    const res = await proxyAwareFetch(
      `${API_BASE}/ads/next?slot=banner`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          "Content-Type": "application/json",
          "x-session-id": sessionId,
          "x-turn-id": turnId,
          "x-client-version": CLI_VERSION,
          "x-client-os": process.platform,
          "x-client-arch": os.arch(),
          "x-ad-trigger": "user_message",
          "x-ad-context": "none",
          ...localeHeaders,
        },
        signal: AbortSignal.timeout(5000),
      },
      proxyOptions
    );
    if (!res.ok) return;
    const ad = await res.json().catch(() => null);
    if (!ad || !ad.ad_id) return;
    if (ad.imp_url && typeof ad.imp_url === "string") {
      proxyAwareFetch(ad.imp_url, { method: "GET", signal: AbortSignal.timeout(4000) }, proxyOptions).catch(() => {});
    }
    await proxyAwareFetch(
      `${API_BASE}/ads/impression`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cleanToken}`,
          "Content-Type": "application/json",
          "x-session-id": sessionId,
        },
        body: JSON.stringify({
          ad_id: ad.ad_id,
          click_token: ad.click_token,
          imp_fired: Boolean(ad.imp_url),
        }),
        signal: AbortSignal.timeout(5000),
      },
      proxyOptions
    );
    lastImpressionMap.set(cleanToken, Date.now());
  } catch {
    // non-blocking
  }
}

/** Per-token FIFO mutex: strict single concurrency (N = 1). */
export async function acquireFreePiQueueLock(token, signal) {
  if (!token || typeof token !== "string") return () => Promise.resolve();
  const cleanToken = token.trim();
  let queue = tokenQueues.get(cleanToken);
  if (!queue) {
    queue = { running: false, waiting: [] };
    tokenQueues.set(cleanToken, queue);
  }
  const createReleaseFn = () => {
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      if (SETTLING_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, SETTLING_DELAY_MS));
      }
      while (queue.waiting.length > 0) {
        const next = queue.waiting.shift();
        if (next && !next.aborted) {
          next.resolve(createReleaseFn());
          return;
        }
      }
      queue.running = false;
    };
  };
  if (!queue.running) {
    queue.running = true;
    return createReleaseFn();
  }
  if (queue.waiting.length >= MAX_QUEUE_SIZE) {
    throw new Error("FreePI queue full: too many concurrent requests queued for this account");
  }
  return new Promise((resolve, reject) => {
    const item = { resolve, reject, aborted: false };
    if (signal) {
      if (signal.aborted) return reject(new Error("Request aborted before acquiring FreePI queue slot"));
      signal.addEventListener("abort", () => {
        item.aborted = true;
        const idx = queue.waiting.indexOf(item);
        if (idx !== -1) queue.waiting.splice(idx, 1);
        reject(new Error("Request aborted while in FreePI queue"));
      }, { once: true });
    }
    queue.waiting.push(item);
  });
}

/** Hold the queue lock for the whole SSE stream lifecycle. */
function wrapStreamWithQueueLock(response, releaseLock) {
  if (!response?.body || typeof response.body.pipeThrough !== "function") {
    releaseLock();
    return response;
  }
  let released = false;
  const safeRelease = () => {
    if (!released) {
      released = true;
      releaseLock();
    }
  };
  const transform = new TransformStream({
    transform(chunk, controller) { controller.enqueue(chunk); },
    flush() { safeRelease(); },
    cancel() { safeRelease(); },
  });
  const pipedBody = response.body.pipeThrough(transform);
  return new Response(pipedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export class FreePiExecutor extends DefaultExecutor {
  constructor() {
    super("freepi");
  }

  buildHeaders(credentials, stream = true, url, model, body) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    const token = credentials?.apiKey || credentials?.accessToken;
    const sessionId = token ? getSessionId(token.trim()) : randomUUID();
    headers["x-client-version"] = CLI_VERSION;
    headers["x-session-id"] = sessionId;
    headers["x-turn-id"] = randomUUID();
    headers["x-ad-context"] = "none";
    return headers;
  }

  async execute(params) {
    const { credentials, proxyOptions, log, signal } = params;
    const token = credentials?.apiKey || credentials?.accessToken;
    const cleanToken = token?.trim?.() || "";
    const sessionId = cleanToken ? getSessionId(cleanToken) : randomUUID();
    const turnId = randomUUID();

    // 1. pre-warm the launch handshake if stale (fire-and-forget)
    if (cleanToken) {
      const lastLaunch = launchHandshakeMap.get(cleanToken) || 0;
      if (Date.now() - lastLaunch >= LAUNCH_HANDSHAKE_TTL_MS) {
        launchSessionHandshake(cleanToken, sessionId, proxyOptions).catch(() => {});
      }
    }
    // 2. heartbeat ad impression (auto-ad ON per owner decision)
    if (cleanToken) {
      const lastImpression = lastImpressionMap.get(cleanToken) || 0;
      if (Date.now() - lastImpression > ADS_INTERVAL_MS) {
        lastImpressionMap.set(cleanToken, Date.now());
        fireAdCycle(cleanToken, sessionId, turnId, proxyOptions).catch(() => {});
      }
    }
    // 3. strict single-concurrency queue per token
    let releaseLock = () => Promise.resolve();
    if (cleanToken) {
      try {
        releaseLock = await acquireFreePiQueueLock(cleanToken, signal);
      } catch (queueErr) {
        log?.warn?.("FREEPI", `Queue acquisition error: ${queueErr.message}`);
        return {
          response: new Response(
            JSON.stringify({ error: { message: queueErr.message, code: "QUEUE_OVERFLOW" } }),
            { status: 429, headers: { "Content-Type": "application/json" } }
          ),
          url: this.buildUrl(params.model, params.stream, 0, credentials),
          headers: {},
          transformedBody: params.body,
        };
      }
    }

    let result;
    try {
      result = await super.execute(params);
      // retry concurrent lock (429) up to 2 times
      if (result?.response?.status === 429 && cleanToken) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const cloned = result.response.clone();
            const text = await cloned.text();
            if (text.includes("concurrent") || text.includes("one request at a time")) {
              log?.info?.("FREEPI", `concurrent lock, wait 2.1s before retry (${attempt}/2)`);
              await new Promise((r) => setTimeout(r, 2100));
              result = await super.execute(params);
              if (result?.response?.ok || result?.response?.status !== 429) break;
            } else break;
          } catch { break; }
        }
      }
      // 403 ads_required → handshake then retry once
      if (result?.response?.status === 403 && cleanToken) {
        try {
          const cloned = result.response.clone();
          const text = await cloned.text();
          if (text.includes("ads_required")) {
            log?.info?.("FREEPI", "ads_required (403), handshake and retrying");
            await launchSessionHandshake(cleanToken, sessionId, proxyOptions);
            result = await super.execute(params);
          } else if (text.includes("belongs to another free-pi account")) {
            log?.warn?.("FREEPI", "Conversation belongs to another FreePI account; new conversation required.");
          }
        } catch { /* keep original result */ }
      }
      if (result?.response?.ok && result.response.body) {
        result.response = wrapStreamWithQueueLock(result.response, releaseLock);
        return result;
      }
      releaseLock();
      return result;
    } catch (err) {
      releaseLock();
      throw err;
    }
  }
}

export default FreePiExecutor;
