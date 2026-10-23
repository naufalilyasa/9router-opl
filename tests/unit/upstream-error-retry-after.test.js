import { describe, it, expect } from "vitest";
import { parseUpstreamError } from "../../open-sse/utils/error.js";
import CodeBuddyIntlExecutor from "../../open-sse/executors/codebuddy-intl.js";
import CodeBuddyCnExecutor from "../../open-sse/executors/codebuddy-cn.js";
import CodexExecutor from "../../open-sse/executors/codex.js";

describe("parseUpstreamError — Retry-After & rate limit reset extraction", () => {
  it("extracts resetsAtMs from Retry-After header in seconds", async () => {
    const res = new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: { "retry-after": "60" }
    });

    const parsed = await parseUpstreamError(res);
    expect(parsed.statusCode).toBe(429);
    expect(parsed.resetsAtMs).toBeGreaterThan(Date.now() + 58_000);
    expect(parsed.resetsAtMs).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  it("extracts resetsAtMs from x-ratelimit-reset-after header", async () => {
    const res = new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: { "x-ratelimit-reset-after": "45" }
    });

    const parsed = await parseUpstreamError(res);
    expect(parsed.statusCode).toBe(429);
    expect(parsed.resetsAtMs).toBeGreaterThan(Date.now() + 43_000);
    expect(parsed.resetsAtMs).toBeLessThanOrEqual(Date.now() + 46_000);
  });

  it("extracts resetsAtMs from x-ratelimit-reset unix epoch timestamp", async () => {
    const futureSec = Math.floor(Date.now() / 1000) + 120;
    const res = new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: { "x-ratelimit-reset": String(futureSec) }
    });

    const parsed = await parseUpstreamError(res);
    expect(parsed.statusCode).toBe(429);
    expect(parsed.resetsAtMs).toBe(futureSec * 1000);
  });

  it("extracts resetsAtMs from 'resets after 2h7m' message format", async () => {
    const res = new Response(JSON.stringify({
      error: { message: "Your quota will reset after 2h7m" }
    }), { status: 429 });

    const parsed = await parseUpstreamError(res);
    const expected = (2 * 3600 + 7 * 60) * 1000;
    expect(parsed.resetsAtMs).toBeGreaterThan(Date.now() + expected - 2000);
    expect(parsed.resetsAtMs).toBeLessThanOrEqual(Date.now() + expected + 2000);
  });

  it("extracts resetsAtMs from 'try again in 5 minutes' message format", async () => {
    const res = new Response(JSON.stringify({
      error: { message: "Rate limit exceeded, please try again in 5 minutes" }
    }), { status: 429 });

    const parsed = await parseUpstreamError(res);
    const expected = 5 * 60 * 1000;
    expect(parsed.resetsAtMs).toBeGreaterThan(Date.now() + expected - 2000);
    expect(parsed.resetsAtMs).toBeLessThanOrEqual(Date.now() + expected + 2000);
  });
});

describe("Executor parseError — CodeBuddy 6004 frequency limit", () => {
  const intlExec = new CodeBuddyIntlExecutor();
  const cnExec = new CodeBuddyCnExecutor();

  it("intl parses code 6004 with exact timestamp and assigns scope: 'account'", () => {
    const body = JSON.stringify({
      code: 6004,
      msg: "超出频率限制, 请于 2026-10-23 20:30:00 UTC+8 后重试"
    });
    const parsed = intlExec.parseError(new Response("", { status: 429 }), body);

    expect(parsed.status).toBe(429);
    expect(parsed.scope).toBe("account");
    expect(parsed.resetsAtMs).toBe(new Date("2026-10-23T20:30:00+08:00").getTime());
  });

  it("intl provides fallback 10m cooldown and scope: 'account' when 6004 lacks timestamp", () => {
    const body = JSON.stringify({
      code: 6004,
      msg: "frequency limit reached"
    });
    const parsed = intlExec.parseError(new Response("", { status: 429 }), body);

    expect(parsed.status).toBe(429);
    expect(parsed.scope).toBe("account");
    expect(parsed.resetsAtMs).toBeGreaterThan(Date.now() + 9 * 60 * 1000);
  });

  it("cn parses code 6004 with scope: 'account'", () => {
    const body = JSON.stringify({
      code: 6004,
      msg: "超出频率限制, 请于 2026-10-23 20:30:00 UTC+8 后重试"
    });
    const parsed = cnExec.parseError(new Response("", { status: 429 }), body);

    expect(parsed.status).toBe(429);
    expect(parsed.scope).toBe("account");
  });
});

describe("Executor parseError — Codex usage_limit_reached", () => {
  const codexExec = new CodexExecutor();

  it("parses usage_limit_reached with scope: 'account'", () => {
    const futureSec = Math.floor(Date.now() / 1000) + 300;
    const body = JSON.stringify({
      error: {
        type: "usage_limit_reached",
        message: "Monthly quota exhausted",
        resets_at: futureSec
      }
    });
    const parsed = codexExec.parseError(new Response("", { status: 429 }), body);

    expect(parsed.status).toBe(429);
    expect(parsed.scope).toBe("account");
    expect(parsed.resetsAtMs).toBe(futureSec * 1000);
  });
});
