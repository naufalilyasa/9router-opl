// Regression guard: fixMissingToolResponses must repair the tool-call graph before it
// reaches a strict upstream. The legacy immediate-next check let two shapes through that
// CodeBuddy/Tencent reject with a generic 400 (cbai `11133 model_param_invalid`, cbcn
// `11148 tool calls and tool results do not match`):
//   1. assistant tool_calls as the LAST message (dangling)
//   2. parallel tool_calls answered only partially
// plus orphan role:tool and id mismatch. Parametrized over the three opencode-harness
// providers (cbai/cbcn/opencode-go) that carry the OpenAI tool shapes.
import { describe, it, expect } from "vitest";
import { fixMissingToolResponses } from "../../open-sse/translator/concerns/toolCall.js";

const PROVIDERS = ["cbai", "cbcn", "opencode-go"];
const OMITTED = '{"error":"Tool execution omitted or cancelled"}';

function graph(body) {
  const pending = new Set();
  const problems = [];
  for (const msg of body.messages) {
    if (msg.role === "assistant") {
      if (pending.size > 0) problems.push(`unanswered before assistant: ${[...pending]}`);
      pending.clear();
      for (const tc of msg.tool_calls || []) pending.add(tc.id);
    } else if (msg.role === "tool") {
      if (!msg.tool_call_id || !pending.has(msg.tool_call_id)) {
        problems.push(`orphan tool result: ${msg.tool_call_id}`);
      } else {
        pending.delete(msg.tool_call_id);
      }
    }
  }
  if (pending.size > 0) problems.push(`dangling at end: ${[...pending]}`);
  return problems;
}

function run(body) {
  return fixMissingToolResponses(body).messages;
}

describe.each(PROVIDERS)("tool-call graph canonicalization (%s)", (provider) => {
  it("repairs an assistant tool_calls block as the last message", () => {
    const messages = run({
      model: "deepseek-v4.1-flash",
      messages: [
        { role: "user", content: "run it" },
        { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "compress", arguments: "{}" } }] },
      ],
    });
    expect(graph({ messages })).toEqual([]);
    expect(messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1", content: OMITTED });
  });

  it("fills the missing results of a partially answered parallel tool block", () => {
    const messages = run({
      model: "deepseek-v4.1-flash",
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", tool_calls: [
          { id: "a", type: "function", function: { name: "x", arguments: "{}" } },
          { id: "b", type: "function", function: { name: "y", arguments: "{}" } },
        ] },
        { role: "tool", tool_call_id: "a", content: "ok" },
      ],
    });
    expect(graph({ messages })).toEqual([]);
    expect(messages.find((m) => m.tool_call_id === "b")).toMatchObject({ role: "tool", content: OMITTED });
    expect(messages.find((m) => m.tool_call_id === "a").content).toBe("ok");
  });

  it("drops an orphan tool result with no preceding assistant call", () => {
    const messages = run({
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", tool_call_id: "ghost", content: "stale" },
      ],
    });
    expect(graph({ messages })).toEqual([]);
    expect(messages.some((m) => m.tool_call_id === "ghost")).toBe(false);
  });

  it("drops a tool result whose id does not match the assistant call, and answers the real id", () => {
    const messages = run({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "ZZ", content: "wrong" },
      ],
    });
    expect(graph({ messages })).toEqual([]);
    expect(messages.some((m) => m.tool_call_id === "ZZ")).toBe(false);
    expect(messages.find((m) => m.tool_call_id === "c1").content).toBe(OMITTED);
  });

  it("leaves a fully answered exchange untouched", () => {
    const input = [
      { role: "user", content: "hi" },
      { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "result" },
      { role: "assistant", content: "done" },
    ];
    expect(run({ messages: structuredClone(input) })).toEqual(input);
  });

  it("leaves a plain no-tool conversation untouched", () => {
    const input = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(run({ messages: structuredClone(input) })).toEqual(input);
  });
});

describe("tool-call graph canonicalization: Claude-shaped bodies", () => {
  it("answers a trailing tool_use with a tool_result block, not a role:tool message", () => {
    const messages = run({
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "compress", input: {} }] },
      ],
    });
    expect(messages.some((m) => m.role === "tool")).toBe(false);
    const result = messages.at(-1);
    expect(result.role).toBe("user");
    expect(result.content.at(-1)).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
  });

  it("keeps a matched tool_result and drops an orphan one", () => {
    const messages = run({
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "t", input: {} }] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
          { type: "tool_result", tool_use_id: "ghost", content: "stale" },
        ] },
      ],
    });
    const allResults = messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((b) => b.type === "tool_result");
    expect(allResults.map((b) => b.tool_use_id)).toEqual(["tu_1"]);
  });
});