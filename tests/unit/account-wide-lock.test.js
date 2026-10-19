// A 401/403 describes the credential, not the model. Before this, only the model
// that happened to fail got locked, so a banned or revoked account stayed first in
// the rotation and every request paid a full upstream round-trip before failing
// over — measured at 4-9s per call versus ~1s on a healthy account.
//
// The lever is `modelLock___all`, which isModelLockActive() already honours for
// every model and clearAccountError() already clears on success. 402/404/429 stay
// model-scoped: an expired plan is per-model on some providers and a rate limit
// almost always is, and the 429 backoff ladder is deliberately short.
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { markAccountUnavailable, clearAccountError } = await import("../../src/sse/services/auth.js");
const { checkFallbackError, isModelLockActive } = await import("../../open-sse/services/accountFallback.js");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-19T16:00:00.000Z"));
  dbMocks.getProviderConnections.mockResolvedValue([{
    id: "cb-banned",
    provider: "codebuddy-intl",
    name: "cb-banned",
    backoffLevel: 0,
  }]);
});

function writtenUpdate() {
  return dbMocks.updateProviderConnection.mock.calls[0]?.[1] || {};
}

describe("checkFallbackError — scope", () => {
  it("marks 401 and 403 as account-scoped", () => {
    expect(checkFallbackError(401, "invalid api key").scope).toBe("account");
    expect(checkFallbackError(403, "forbidden").scope).toBe("account");
  });

  it("keeps 402/404/429 model-scoped", () => {
    for (const status of [402, 404, 429]) {
      expect(checkFallbackError(status, "nope").scope).toBeUndefined();
    }
  });

  it("keeps the codebuddy-intl 11140 ban account-scoped through the status rule", () => {
    // 11140 arrives as 403 with "request illegal"; the provider-scoped text rule
    // sits after the status rules, so the 403 rule wins and brings scope with it.
    const result = checkFallbackError(403, '{"code":11140,"msg":"request illegal"}', 0, "codebuddy-intl");
    expect(result.cooldownMs).toBe(120000);
    expect(result.scope).toBe("account");
  });

  it("keeps the codebuddy-intl 11128 WAF block model-scoped", () => {
    // A WAF block is per-IP/per-window, not per-credential: benching the account
    // for every model would turn a transient block into a provider-wide outage.
    const result = checkFallbackError(400, '{"code":11128,"msg":"request illegal"}', 0, "codebuddy-intl");
    expect(result.cooldownMs).toBe(120000);
    expect(result.scope).toBeUndefined();
  });
});

describe("markAccountUnavailable — account-wide locks", () => {
  it("writes modelLock___all for a 403 ban", async () => {
    await markAccountUnavailable("cb-banned", 403, '{"code":11140,"msg":"request illegal"}', "codebuddy-intl", "glm-5.2");

    expect(writtenUpdate()).toMatchObject({
      modelLock___all: "2026-10-19T16:02:00.000Z",
      testStatus: "unavailable",
      errorCode: 403,
    });
    expect(writtenUpdate()).not.toHaveProperty("modelLock_glm-5.2");
  });

  it("writes modelLock___all for a 401 bad key", async () => {
    await markAccountUnavailable("cb-banned", 401, "invalid api key", "codebuddy-intl", "glm-5.2");

    expect(writtenUpdate()).toHaveProperty("modelLock___all");
    expect(writtenUpdate()).not.toHaveProperty("modelLock_glm-5.2");
  });

  it("keeps a 429 model-scoped so one busy model does not bench the account", async () => {
    await markAccountUnavailable("cb-banned", 429, "too many requests", "codebuddy-intl", "glm-5.2");

    expect(writtenUpdate()).toHaveProperty("modelLock_glm-5.2");
    expect(writtenUpdate()).not.toHaveProperty("modelLock___all");
  });

  it("keeps a 402 model-scoped (plan limits are per-model on some providers)", async () => {
    await markAccountUnavailable("cb-banned", 402, "Payment required", "github", "claude-fable-5");

    expect(writtenUpdate()).toHaveProperty("modelLock_claude-fable-5");
    expect(writtenUpdate()).not.toHaveProperty("modelLock___all");
  });
});

describe("account-wide lock lifecycle", () => {
  it("blocks every model while the lock is live", () => {
    const conn = { modelLock___all: "2026-10-19T16:02:00.000Z" };

    for (const model of ["glm-5.2", "kimi-k2.7", "deepseek-v4.1-flash", null]) {
      expect(isModelLockActive(conn, model)).toBe(true);
    }
  });

  it("frees every model once the lock expires", () => {
    const conn = { modelLock___all: "2026-10-19T15:59:00.000Z" };
    expect(isModelLockActive(conn, "glm-5.2")).toBe(false);
  });

  // Regression: `connection[key] || connection[MODEL_LOCK_ALL]` picked the first
  // key with a value, not the one that is still live. A stale per-model lock left
  // over from an earlier 429 shadowed a newer account-wide ban, so a banned
  // account stayed selectable for every model except that one.
  it("does not let an expired per-model lock shadow a live account-wide lock", () => {
    const conn = {
      "modelLock_kimi-k2.6": "2026-10-19T15:59:00.000Z", // expired
      modelLock___all: "2026-10-19T16:02:00.000Z",       // live
    };
    expect(isModelLockActive(conn, "kimi-k2.6")).toBe(true);
    expect(isModelLockActive(conn, "glm-5.2")).toBe(true);
  });

  it("still reports the per-model lock when only that one is live", () => {
    const conn = {
      "modelLock_kimi-k2.6": "2026-10-19T16:02:00.000Z", // live
      modelLock___all: "2026-10-19T15:59:00.000Z",       // expired
    };
    expect(isModelLockActive(conn, "kimi-k2.6")).toBe(true);
    expect(isModelLockActive(conn, "glm-5.2")).toBe(false);
  });

  it("reports no lock when both keys are expired", () => {
    const conn = {
      "modelLock_kimi-k2.6": "2026-10-19T15:59:00.000Z",
      modelLock___all: "2026-10-19T15:58:00.000Z",
    };
    expect(isModelLockActive(conn, "kimi-k2.6")).toBe(false);
  });

  it("clears the account-wide lock on a successful request", async () => {
    const conn = {
      modelLock___all: "2026-10-19T16:02:00.000Z",
      testStatus: "unavailable",
      lastError: "[403]: request illegal",
      errorCode: 403,
    };

    await clearAccountError("cb-banned", conn, "glm-5.2");

    expect(writtenUpdate()).toMatchObject({
      modelLock___all: null,
      testStatus: "active",
      lastError: null,
      errorCode: null,
      backoffLevel: 0,
    });
  });
});
