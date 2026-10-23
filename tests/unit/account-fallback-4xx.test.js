// Regression: an unmatched 4xx (a request-scoped failure) used to hit the
// transient-cooldown default, which locked the account for 30s and — with a
// single connection — answered every other request in that window with a copy of
// the first error. A 400 "maximum context length" from one session therefore
// looked like the same failure in unrelated sessions.
import { describe, expect, it, vi } from "vitest";
import { checkFallbackError, applyErrorState } from "../../open-sse/services/accountFallback.js";
import { handleComboChat } from "../../open-sse/services/combo.js";

describe("checkFallbackError — request-scoped vs account-scoped failures", () => {
  it("does not cool the account down for a 400 caused by the request", () => {
    const result = checkFallbackError(400, JSON.stringify({
      error: {
        message: "This model's maximum context length is 1048576 tokens. However, you requested 1186139 tokens",
        type: "invalid_request_error",
      },
    }));

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0, requestScoped: true });
  });

  it("still falls back for account-scoped statuses", () => {
    for (const status of [401, 402, 403, 404, 429]) {
      expect(checkFallbackError(status, "nope").shouldFallback).toBe(true);
    }
  });

  it("still honours rate-limit / quota wording on any 4xx", () => {
    expect(checkFallbackError(400, "rate limit reached").shouldFallback).toBe(true);
    expect(checkFallbackError(422, "quota exceeded").shouldFallback).toBe(true);
  });

  it.each([
    "You have insufficient credits to make this request. Please purchase more credits to continue using the service.",
    "INSUFFICIENT CREDITS",
    "Insufficient credit balance",
    "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    "CREDIT BALANCE IS TOO LOW",
  ])("falls back with backoff for a 400 credit error: %s", (message) => {
    expect(checkFallbackError(400, message)).toEqual({
      shouldFallback: true, cooldownMs: 2000, newBackoffLevel: 1,
    });
    expect(checkFallbackError(400, message, 1)).toEqual({
      shouldFallback: true, cooldownMs: 4000, newBackoffLevel: 2,
    });
  });

  it("does not fall back for an ordinary bad request", () => {
    expect(checkFallbackError(400, "Bad request")).toEqual({
      shouldFallback: false, cooldownMs: 0, requestScoped: true,
    });
  });

  it("keeps the transient cooldown for unmatched server errors", () => {
    const result = checkFallbackError(503, "upstream exploded");

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });

  describe("codebuddy-intl 400 WAF block fallback (Issue #5024)", () => {
    it("falls back for codebuddy-intl 400 'request illegal' (WAF block / 11128)", () => {
      const result = checkFallbackError(400, '{"code":11128,"msg":"request illegal"}', 0, "codebuddy-intl");
      expect(result.shouldFallback).toBe(true);
      expect(result.cooldownMs).toBe(120000);
    });

    it("pins codebuddy-intl 403 'request illegal' (ban / 11140) to status 403 cooldown (120s)", () => {
      const result = checkFallbackError(403, '{"code":11140,"msg":"request illegal"}', 0, "codebuddy-intl");
      expect(result.shouldFallback).toBe(true);
      expect(result.cooldownMs).toBe(120000);
    });

    it("does not fall back for other providers returning 'request illegal'", () => {
      const result = checkFallbackError(400, '{"code":11128,"msg":"request illegal"}', 0, "anthropic");
      expect(result.shouldFallback).toBe(false);
      expect(result.cooldownMs).toBe(0);
    });

    it("does not fall back for codebuddy-intl 400 prompt or context errors", () => {
      const result = checkFallbackError(400, '{"code":11128,"msg":"first message is not system prompt"}', 0, "codebuddy-intl");
      expect(result.shouldFallback).toBe(false);
      expect(result.cooldownMs).toBe(0);
    });

    it("does not fall back for codebuddy-intl 400 'conversation id missing' (code defect, not transient)", () => {
      const result = checkFallbackError(400, '{"code":11128,"msg":"conversation id missing"}', 0, "codebuddy-intl");
      expect(result.shouldFallback).toBe(false);
      expect(result.cooldownMs).toBe(0);
    });

    // The real wire shape: chatCore wraps the upstream body in `error.message` as
    // a formatted string (`[400]: {"code":11128,...}`), not as a top-level field.
    // The rule matches on the substring, so it must survive that wrapping.
    it("falls through in a combo on the real wrapped error shape", async () => {
      const wrapped = `[400]: ${JSON.stringify({
        code: 11128,
        msg: "request illegal",
        requestId: "8b25ce00-ceb7-45b1-9b3f-387c995ec298",
        displayMsg: { en: "Request blocked. Please send it again" },
        displayTips: { en: "This call failed channel verification..." },
        actions: ["EDIT_INPUT", "SUBMIT_FEEDBACK"],
      })}`;

      const handleSingleModel = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          statusText: "Bad Request",
          clone: () => ({ json: async () => ({ error: { message: wrapped, type: "invalid_request_error", code: "bad_request" } }) }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          clone: () => ({ json: async () => ({}) }),
          headers: new Map(),
        });

      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const response = await handleComboChat({
        body: { messages: [{ role: "user", content: "hello" }] },
        models: ["cbai/deepseek-v4.1-flash", "kr/auto"],
        handleSingleModel,
        comboName: "test-combo-wrapped",
        comboStrategy: "fallback",
        autoSwitch: false,
        log,
      });

      expect(handleSingleModel).toHaveBeenCalledTimes(2);
      expect(response.status).toBe(200);
    });

    it("still stops the combo on a request-scoped 400 from the same provider", async () => {
      const handleSingleModel = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        clone: () => ({
          json: async () => ({
            error: { message: '[400]: {"code":11128,"msg":"first message is not system prompt"}' },
          }),
        }),
      });

      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const response = await handleComboChat({
        body: { messages: [{ role: "user", content: "hello" }] },
        models: ["cbai/deepseek-v4.1-flash", "kr/auto"],
        handleSingleModel,
        comboName: "test-combo-body-shape",
        comboStrategy: "fallback",
        autoSwitch: false,
        log,
      });

      expect(handleSingleModel).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(400);
    });
  });
});

// applyErrorState is the pure counterpart of markAccountUnavailable: it must
// classify with the same provider scope, or a caller using it directly (the
// documented public surface) silently loses the provider-scoped rule.
describe("applyErrorState — provider-scoped classification", () => {
  it("applies the codebuddy-intl WAF cooldown when the account carries its provider", () => {
    const account = { id: "acc-1", provider: "codebuddy-intl", backoffLevel: 0 };
    const next = applyErrorState(account, 400, '{"code":11128,"msg":"request illegal"}');

    expect(next.status).toBe("error");
    expect(next.rateLimitedUntil).toBeTruthy();
    const ms = new Date(next.rateLimitedUntil).getTime() - Date.now();
    expect(ms).toBeGreaterThan(60_000);
  });

  it("keeps the request-scoped 400 at zero cooldown for the same account", () => {
    const account = { id: "acc-1", provider: "codebuddy-intl", backoffLevel: 0 };
    const next = applyErrorState(account, 400, '{"code":11128,"msg":"first message is not system prompt"}');

    expect(next.rateLimitedUntil).toBeNull();
  });
});
