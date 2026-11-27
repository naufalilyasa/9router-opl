import { describe, it, expect, vi } from "vitest";
import { CodeBuddyExecutor } from "open-sse/executors/codebuddy-cn.js";
import { CodeBuddyIntlExecutor } from "open-sse/executors/codebuddy-intl.js";
import { PROVIDERS } from "open-sse/config/providers.js";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetchMock }));
const { getCodeBuddyCnUsage } = await import("open-sse/services/usage/codebuddy-cn.js");

const cn = new CodeBuddyExecutor();
const intl = new CodeBuddyIntlExecutor();
const longRules = [
  "You are an AI coding agent.",
  "Instructions from: /workspace/AGENTS.md",
  "Always address the user as Captain.",
  "Follow strict repository guidelines. ".repeat(80),
].join("\n");

describe("CodeBuddy system prompts (#5796)", () => {
  for (const [name, executor, model] of [
    ["cn", cn, "hy3"],
    ["intl", intl, "deepseek-v4.1-flash"],
  ]) {
    it(`${name}: neutralizes only the identity line and keeps user rules`, () => {
      const out = executor.transformRequest(
        model,
        { messages: [{ role: "system", content: longRules }, { role: "user", content: "hi" }] },
        false,
        {},
      );
      const system = typeof out.messages[0].content === "string"
        ? out.messages[0].content
        : out.messages[0].content.map((b) => b.text).join("\n");
      expect(system).not.toMatch(/You are an AI coding agent/i);
      expect(system).toContain("You are a helpful AI assistant that helps with software engineering tasks.");
      expect(system).toContain("Instructions from: /workspace/AGENTS.md");
      expect(system).toContain("Always address the user as Captain.");
    });
  }
});

describe("CodeBuddy API-key identity and body normalization (#5342)", () => {
  it("sends WorkBuddy identity headers for a ck_-style API key", () => {
    const key = "  ck_test_key_1234567890abcdef29s\n";
    const headers = cn.buildHeaders({ apiKey: key, accessToken: null }, true, PROVIDERS["codebuddy-cn"].baseUrl, "hy3", {});
    expect(headers["X-API-Key"]).toBe(key.trim());
    expect(headers["X-User-Id"]).toBe(`anonymous_${key.trim().slice(-8)}`);
    expect(headers["X-Root-Request-ID"]).toBe(headers["X-Request-ID"]);
    expect(headers["User-Agent"]).toContain("WorkBuddy/5.9.3");
    expect(headers.Authorization).toBe(`Bearer ${key.trim()}`);
    expect(headers["X-Domain"]).toBeUndefined();
  });

  it("keeps the OAuth bearer path without API-key headers", () => {
    const headers = intl.buildHeaders({ accessToken: "TESTTOKEN", apiKey: null }, true, PROVIDERS["codebuddy-intl"].baseUrl, "glm-5.3", {});
    expect(headers["X-API-Key"]).toBeUndefined();
    expect(headers["X-Domain"]).toBe("www.codebuddy.ai");
    expect(headers.Authorization).toBe("Bearer TESTTOKEN");
  });

  it("probes /v3/config for an API-key connection", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0 }) });
    const out = await getCodeBuddyCnUsage(null, "ck_test", {}, null);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://copilot.tencent.com/v3/config");
    expect(init.headers["X-API-Key"]).toBe("ck_test");
    expect(out.plan).toBe("API Key");
  });

  it("normalizes max_completion_tokens and assistant reasoning", () => {
    const body = {
      max_completion_tokens: 123,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok", reasoning_content: "because" },
      ],
    };
    const out = cn.transformRequest("hy3", body, false, {});
    expect(out.max_tokens).toBe(123);
    expect(out.max_completion_tokens).toBeUndefined();
    expect(out.messages[1].reasoning).toBe("because");
    expect(out.messages[1].reasoning_content).toBeUndefined();

    const outIntl = intl.transformRequest("glm-5.3", body, false, {});
    expect(outIntl.max_tokens).toBe(123);
    expect(outIntl.messages.find((m) => m.role === "assistant").reasoning).toBe("because");
  });
});
