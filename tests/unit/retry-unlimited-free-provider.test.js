// Free-tier upstreams (the `freeai` custom node, all its prem/* models) answer 429 until
// a slot frees up. The default ladder retries 429 zero times and custom nodes fall back to
// PROVIDERS.openai (retry: undefined), so a rate-limited free model failed the whole turn.
// Those providers now merge UNLIMITED_RETRY_CONFIG: attempts -1 = retry until the client aborts.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_CONFIG,
  UNLIMITED_RETRY_CONFIG,
  isUnlimitedRetryProvider,
  resolveRetryEntry,
  shouldRetryAttempt,
} from "../../open-sse/config/runtimeConfig.js";

const effective = (provider) => ({
  ...DEFAULT_RETRY_CONFIG,
  ...(isUnlimitedRetryProvider(provider) ? UNLIMITED_RETRY_CONFIG : null),
});

describe("unlimited retry for free providers", () => {
  it("matches the freeai node and nothing else", () => {
    expect(isUnlimitedRetryProvider("openai-compatible-chat-freeai")).toBe(true);
    expect(isUnlimitedRetryProvider("openai-compatible-chat-freeai-2")).toBe(true);
    expect(isUnlimitedRetryProvider("openai-compatible-chat-agentrouter")).toBe(false);
    expect(isUnlimitedRetryProvider("openai")).toBe(false);
    expect(isUnlimitedRetryProvider(undefined)).toBe(false);
  });

  it("lifts the zero-attempt 402/429 defaults for the freeai node only", () => {
    const free = resolveRetryEntry(effective("openai-compatible-chat-freeai")[429]);
    expect(free.attempts).toBe(-1);

    const paid = resolveRetryEntry(effective("openai")[429]);
    expect(paid.attempts).toBe(0);

    for (const status of [402, 429, 500, 502, 503, 504]) {
      expect(resolveRetryEntry(effective("openai-compatible-chat-freeai")[status]).attempts).toBe(-1);
    }
  });

  it("keeps counting forever when unlimited, still caps fixed ladders", () => {
    expect(shouldRetryAttempt(-1, 0)).toBe(true);
    expect(shouldRetryAttempt(-1, 10000)).toBe(true);
    expect(shouldRetryAttempt(3, 2)).toBe(true);
    expect(shouldRetryAttempt(3, 3)).toBe(false);
    expect(shouldRetryAttempt(0, 0)).toBe(false);
  });
});
