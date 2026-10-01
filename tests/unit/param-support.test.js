import { describe, it, expect } from "vitest";

import { stripUnsupportedParams } from "../../open-sse/translator/concerns/paramSupport.js";

describe("stripUnsupportedParams", () => {
  it("flattens Cloudflare AI OpenAI content-part arrays", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello " },
            { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
            { type: "text", text: "world" },
          ],
        },
      ],
    };

    expect(() => stripUnsupportedParams("cloudflare-ai", "@cf/meta/llama-3.1-8b-instruct", body)).not.toThrow();
    expect(body.messages[0].content).toBe("hello world");
  });

  it("still drops unsupported GitHub model params", () => {
    const body = { temperature: 0.7, top_p: 1 };

    stripUnsupportedParams("github", "gpt-5.4", body);

    expect(body).toEqual({ top_p: 1 });
  });

  it("clamps VolcEngine Ark GLM max token fields to the model output ceiling", () => {
    const body = {
      max_tokens: 131072,
      max_completion_tokens: 131072,
      max_output_tokens: 131072,
    };

    stripUnsupportedParams("volcengine-ark", "GLM-5.2", body);

    expect(body).toEqual({
      max_tokens: 128000,
      max_completion_tokens: 128000,
      max_output_tokens: 128000,
    });
  });

  it("keeps VolcEngine Ark GLM max tokens when already under the ceiling", () => {
    const body = { max_tokens: 64000 };

    stripUnsupportedParams("volcengine-ark", "GLM-5.2", body);

    expect(body.max_tokens).toBe(64000);
  });

  it("drops replayed reasoning fields from assistant messages for strict providers", () => {
    const makeBody = () => ({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "hello",
          reasoning_content: "thinking...",
          reasoning: "thinking...",
          reasoning_details: [{ text: "thinking..." }],
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        { role: "user", content: "again", reasoning_content: "user-side field stays" },
      ],
    });

    for (const [provider, model] of [
      ["groq", "openai/gpt-oss-120b"],
      ["mistral", "codestral-latest"],
      ["cerebras", "gpt-oss-120b"],
    ]) {
      const body = makeBody();
      stripUnsupportedParams(provider, model, body);
      expect(body.messages[1]).toEqual({
        role: "assistant",
        content: "hello",
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
      });
      // only assistant turns are touched
      expect(body.messages[2].reasoning_content).toBe("user-side field stays");
    }
  });

  it("leaves reasoning fields alone for providers that accept or require them", () => {
    const body = {
      messages: [{ role: "assistant", content: "hello", reasoning_content: "thinking..." }],
    };

    stripUnsupportedParams("deepseek", "deepseek-reasoner", body);
    stripUnsupportedParams("openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free", body);

    expect(body.messages[0].reasoning_content).toBe("thinking...");
  });

  it("coerces CodeBuddy object tool_choice to the nearest string form", () => {
    for (const provider of ["codebuddy-intl", "codebuddy-cn"]) {
      const forced = { tool_choice: { type: "function", function: { name: "probe_tool" } } };
      stripUnsupportedParams(provider, "deepseek-v4.1-flash", forced);
      expect(forced.tool_choice).toBe("required");

      const auto = { tool_choice: { type: "auto" } };
      stripUnsupportedParams(provider, "deepseek-v4.1-flash", auto);
      expect(auto.tool_choice).toBe("auto");

      const none = { tool_choice: { type: "none" } };
      stripUnsupportedParams(provider, "deepseek-v4.1-flash", none);
      expect(none.tool_choice).toBe("none");
    }
  });

  it("keeps CodeBuddy string tool_choice and leaves other providers untouched", () => {
    const asString = { tool_choice: "required" };
    stripUnsupportedParams("codebuddy-intl", "deepseek-v4.1-flash", asString);
    expect(asString.tool_choice).toBe("required");

    const other = { tool_choice: { type: "function", function: { name: "x" } } };
    stripUnsupportedParams("openai", "gpt-5", other);
    expect(other.tool_choice).toEqual({ type: "function", function: { name: "x" } });
  });

  it("renames CodeBuddy max_completion_tokens to max_tokens (11133 otherwise)", () => {
    for (const provider of ["codebuddy-intl", "codebuddy-cn"]) {
      const only = { max_completion_tokens: 298380 };
      stripUnsupportedParams(provider, "deepseek-v4.1-flash", only);
      expect(only).toEqual({ max_tokens: 298380 });

      const both = { max_tokens: 4096, max_completion_tokens: 298380 };
      stripUnsupportedParams(provider, "deepseek-v4.1-flash", both);
      expect(both).toEqual({ max_tokens: 4096 });

      const neither = { temperature: 0.5 };
      stripUnsupportedParams(provider, "deepseek-v4.1-flash", neither);
      expect(neither).toEqual({ temperature: 0.5 });
    }
  });

  it("leaves max_completion_tokens alone for other providers", () => {
    const body = { max_completion_tokens: 8192 };
    stripUnsupportedParams("openai", "gpt-5", body);
    expect(body.max_completion_tokens).toBe(8192);
  });
});
