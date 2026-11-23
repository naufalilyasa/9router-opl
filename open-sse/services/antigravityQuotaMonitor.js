/**
 * Proactive Antigravity quota pre-check (safe subset port from xrouter 83b646d).
 *
 * Queries v1internal:retrieveUserQuotaSummary, checks the model family bucket
 * and fails open on any transient error so a quota API outage never blocks
 * traffic. No TLS client and no extra headers are ported — the fork's local
 * header policy stays untouched.
 */

import { createHash } from "node:crypto";
import { ANTIGRAVITY_IDE_BASE_URL, ANTIGRAVITY_IDE_USER_AGENT, ANTIGRAVITY_IDE_VERSION } from "../providers/shared.js";
import { fetchWithTimeout } from "./usage/shared.js";

const QUOTA_SUMMARY_URL = `${ANTIGRAVITY_IDE_BASE_URL}/v1internal:retrieveUserQuotaSummary`;
const CACHE_TTL_MS = 60_000;
const DRAINED_THRESHOLD = 0.02;

const summaryCache = new Map();

export function _clearQuotaMonitorCache() {
  summaryCache.clear();
}

function cacheKey(connectionId, accessToken) {
  const tokenHash = createHash("sha256").update(String(accessToken)).digest("hex").slice(0, 12);
  return `${connectionId}::${tokenHash}`;
}

function familyPatternFor(model) {
  const clean = String(model || "").replace(/^ag\//, "").trim().toLowerCase();
  if (clean.startsWith("claude-") || clean.startsWith("gpt-")) return /claude|gpt/i;
  if (clean.includes("argon")) return /argon/i;
  return /gemini/i;
}

function extractGroups(data) {
  if (!data || typeof data !== "object") return null;
  return (
    (Array.isArray(data.groups) && data.groups) ||
    (Array.isArray(data.quotaSummary?.groups) && data.quotaSummary.groups) ||
    (Array.isArray(data.response?.groups) && data.response.groups) ||
    null
  );
}

function isSessionBucket(bucket) {
  const windowType = String(bucket.window || "").toLowerCase();
  const bucketText = `${bucket.bucketId || ""} ${bucket.displayName || ""}`.toLowerCase();
  return windowType === "5h" || bucketText.includes("five hour") || bucketText.includes("5h") || bucketText.includes("daily") || windowType === "daily";
}

function isWeeklyBucket(bucket) {
  const windowType = String(bucket.window || "").toLowerCase();
  const bucketText = `${bucket.bucketId || ""} ${bucket.displayName || ""}`.toLowerCase();
  return windowType === "weekly" || bucketText.includes("weekly");
}

export function parseMostRestrictiveBucket(data, model) {
  const groups = extractGroups(data);
  if (!groups) return null;

  const pattern = familyPatternFor(model);
  let worst = null;

  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    if (!pattern.test(group.displayName || "")) continue;

    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== "object") continue;
      const isWeekly = isWeeklyBucket(bucket);
      const isSession = isSessionBucket(bucket);
      if (!isWeekly && !isSession) continue;
      if (bucket.disabled === true && isWeekly) continue;

      const remainingFraction = bucket.disabled === true ? 0 : Number(bucket.remainingFraction);
      if (!Number.isFinite(remainingFraction)) continue;
      if (!worst || remainingFraction < worst.remainingFraction) {
        worst = { remainingFraction, resetTime: bucket.resetTime || null };
      }
    }
  }

  return worst;
}

async function fetchQuotaSummary(accessToken, proxyOptions) {
  const response = await fetchWithTimeout(
    QUOTA_SUMMARY_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
        "Content-Type": "application/json",
        "X-Client-Name": "antigravity",
        "X-Client-Version": ANTIGRAVITY_IDE_VERSION,
      },
      body: JSON.stringify({}),
    },
    10_000,
    proxyOptions
  );
  if (!response.ok) return null;
  const data = await response.json();
  return extractGroups(data) ? data : null;
}

function computeDrained(outcome, model) {
  if (!outcome?.ok || !outcome.data) return null;
  const worst = parseMostRestrictiveBucket(outcome.data, model);
  if (!worst) return null;
  const resetMs = worst.resetTime ? new Date(worst.resetTime).getTime() : NaN;
  return {
    isDrained: worst.remainingFraction <= DRAINED_THRESHOLD,
    resetTime: Number.isFinite(resetMs) ? worst.resetTime : null,
  };
}

export async function isAntigravityQuotaDrained(accessToken, model, proxyOptions = null, connectionId = "default") {
  const failOpen = { isDrained: false, resetTime: null };
  if (!accessToken || !model) return failOpen;

  const key = cacheKey(connectionId, accessToken);
  const hit = summaryCache.get(key);

  if (hit?.promise) {
    try {
      const outcome = await hit.promise;
      return computeDrained(outcome, model) || failOpen;
    } catch {
      return failOpen;
    }
  }
  if (hit && hit.expiresAt > Date.now()) return computeDrained(hit.result, model) || failOpen;

  const promise = (async () => {
    try {
      const data = await fetchQuotaSummary(accessToken, proxyOptions);
      return data ? { data, ok: true } : failOpen;
    } catch {
      return failOpen;
    }
  })();

  summaryCache.set(key, { promise });

  let outcome;
  try {
    outcome = await promise;
  } catch {
    summaryCache.delete(key);
    return failOpen;
  }

  if (outcome?.ok) summaryCache.set(key, { result: outcome, expiresAt: Date.now() + CACHE_TTL_MS });
  else summaryCache.delete(key);

  if (!outcome?.ok) return failOpen;
  return computeDrained(outcome, model) || failOpen;
}
