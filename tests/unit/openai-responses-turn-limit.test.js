import { describe, it, expect } from "vitest";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";

const chatWithTurns = (turns) => {
  const messages = [];
  for (let i = 1; i <= turns; i++) {
    messages.push({ role: "user", content: `turn ${i}` });
    if (i < turns) messages.push({ role: "assistant", content: `${i}` });
  }
  return { messages };
};

const userItems = (input) =>
  input.filter((item) => item.type === "message" && item.role === "user");

describe("Responses history turn cap", () => {
  it("keeps the last N user turns when maxResponsesTurns is set", () => {
    const out = openaiToOpenAIResponsesRequest(
      "xc/gpt-6.1-sol",
      chatWithTurns(12),
      true,
      { providerSpecificData: { maxResponsesTurns: 10 } }
    );

    const users = userItems(out.input);
    expect(users).toHaveLength(10);
    expect(users[0].content[0].text).toBe("turn 3");
    expect(users[9].content[0].text).toBe("turn 12");
  });

  it("does not trim when maxResponsesTurns is absent", () => {
    const out = openaiToOpenAIResponsesRequest(
      "xc/gpt-6.1-sol",
      chatWithTurns(12),
      true,
      {}
    );

    expect(userItems(out.input)).toHaveLength(12);
  });

  it("trims pre-normalized Responses input too", () => {
    const input = Array.from({ length: 12 }, (_, i) => ({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `turn ${i + 1}` }],
    }));

    const out = openaiToOpenAIResponsesRequest(
      "xc/gpt-6.1-sol",
      { input },
      true,
      { providerSpecificData: { maxResponsesTurns: 10 } }
    );

    expect(userItems(out.input)).toHaveLength(10);
    expect(out.input[0].content[0].text).toBe("turn 3");
  });
});
