import { describe, expect, it } from "vitest";

import { resolveRoutingSessionKey } from "../../open-sse/utils/sessionManager.js";

const msg = (role, content) => ({ role, content });

describe("resolveRoutingSessionKey (account affinity key)", () => {
  it("prefers Claude Code session id from metadata", () => {
    const key = resolveRoutingSessionKey({
      headers: {},
      body: { metadata: { user_id: JSON.stringify({ session_id: "cc-123" }) } },
    });
    expect(key).toBe("claude:cc-123");
  });

  it("prefers Claude Code session header", () => {
    const key = resolveRoutingSessionKey({ headers: { "x-claude-code-session-id": "cc-456" }, body: {} });
    expect(key).toBe("claude:cc-456");
  });

  it("uses client session headers", () => {
    expect(resolveRoutingSessionKey({ headers: { "x-session-id": "abc" }, body: {} })).toBe("abc");
    expect(resolveRoutingSessionKey({ headers: { "session-id": "def" }, body: {} })).toBe("def");
    expect(resolveRoutingSessionKey({ headers: { "x-amp-thread-id": "t-1" }, body: {} })).toBe("t-1");
  });

  it("uses body session fields when no header is present", () => {
    expect(resolveRoutingSessionKey({ headers: {}, body: { prompt_cache_key: "pck-1" } })).toBe("pck-1");
    expect(resolveRoutingSessionKey({ headers: {}, body: { session_id: "sid-1" } })).toBe("sid-1");
    expect(resolveRoutingSessionKey({ headers: {}, body: { conversation_id: "cid-1" } })).toBe("cid-1");
  });

  it("hashes the first user message as the fallback key", () => {
    const a = resolveRoutingSessionKey({
      headers: {},
      body: { messages: [msg("system", "sys"), msg("user", "Tulis fungsi isEven(n)")] },
    });
    const b = resolveRoutingSessionKey({
      headers: {},
      body: { messages: [msg("system", "sys"), msg("user", "Tulis fungsi isEven(n)"), msg("assistant", "ok"), msg("user", "lanjut")] },
    });
    expect(a).toMatch(/^msg1:[0-9a-f]{16}$/);
    // Same first user message → same key on every later turn of the conversation
    expect(b).toBe(a);
  });

  it("returns null when the request carries no stable signal", () => {
    expect(resolveRoutingSessionKey({ headers: {}, body: { messages: [] } })).toBeNull();
    expect(resolveRoutingSessionKey({ headers: {}, body: { messages: [msg("system", "sys")] } })).toBeNull();
    expect(resolveRoutingSessionKey({ headers: {}, body: { messages: [msg("assistant", "hello")] } })).toBeNull();
  });

  it("ignores x-client-request-id (minted per request by some clients)", () => {
    const key = resolveRoutingSessionKey({
      headers: { "x-client-request-id": "req-uuid-1" },
      body: { messages: [msg("user", "halo dunia")] },
    });
    expect(key).toMatch(/^msg1:/);
  });
});
