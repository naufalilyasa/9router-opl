// Regression guard: CodeBuddy gateways reject tool definitions whose parameters
// schema lacks `type: "object"` (cbcn `11129 invalid function call parameters`,
// "Invalid tool definition"). stripUnsupportedParams must default the shape for
// codebuddy-intl/cn and leave other providers untouched.
import { describe, it, expect } from "vitest";
import { stripUnsupportedParams } from "../../open-sse/translator/concerns/paramSupport.js";

const run = (provider, tools) =>
  stripUnsupportedParams(provider, "deepseek-v4.1-flash", { model: "deepseek-v4.1-flash", tools }).tools;

describe.each(["codebuddy-intl", "codebuddy-cn"])("tool parameters defaults (%s)", (provider) => {
  it("adds type:object + properties to a typeless parameters schema", () => {
    const tools = run(provider, [
      { type: "function", function: { name: "t", description: "d", parameters: { properties: { q: { type: "string" } } } } },
    ]);
    expect(tools[0].function.parameters).toMatchObject({ type: "object" });
    expect(tools[0].function.parameters.properties.q).toEqual({ type: "string" });
  });

  it("creates a default schema when parameters is missing", () => {
    const tools = run(provider, [
      { type: "function", function: { name: "t", description: "d" } },
    ]);
    expect(tools[0].function.parameters).toEqual({ type: "object", properties: {} });
  });

  it("keeps a valid schema untouched", () => {
    const schema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
    const tools = run(provider, [
      { type: "function", function: { name: "t", description: "d", parameters: structuredClone(schema) } },
    ]);
    expect(tools[0].function.parameters).toEqual(schema);
  });

  it("strips the pattern keyword at top level and nested", () => {
    const tools = run(provider, [
      { type: "function", function: { name: "t", description: "d", parameters: {
        type: "object",
        properties: {
          runId: { type: "string", pattern: "^agent\\_run\\_" },
          nested: { type: "object", properties: { x: { type: "string", pattern: "^a" } } },
        },
      } } },
    ]);
    const params = tools[0].function.parameters;
    expect(params.properties.runId.pattern).toBeUndefined();
    expect(params.properties.runId.type).toBe("string");
    expect(params.properties.nested.properties.x.pattern).toBeUndefined();
  });

  it("keeps a property NAMED pattern (glob/grep shape) while stripping its keyword", () => {
    const tools = run(provider, [
      { type: "function", function: { name: "glob", description: "d", parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "The glob pattern to match files against" },
          path: { type: "string" },
        },
        required: ["pattern"],
      } } },
    ]);
    const params = tools[0].function.parameters;
    expect(params.properties.pattern).toEqual({ type: "string", description: "The glob pattern to match files against" });
    expect(params.required).toEqual(["pattern"]);
  });

  it("keeps a property named pattern but strips its inner keyword", () => {
    const tools = run(provider, [
      { type: "function", function: { name: "grep", description: "d", parameters: {
        type: "object",
        properties: { pattern: { type: "string", pattern: "^x" } },
      } } },
    ]);
    const params = tools[0].function.parameters;
    expect(params.properties.pattern).toEqual({ type: "string" });
  });
});

describe.each(["codebuddy-intl", "codebuddy-cn", "opencode-go"])(
  "tool parameters defaults: other providers untouched (%s)",
  (provider) => {
    it("does not modify schemas for non-gated providers", () => {
      const input = [{ type: "function", function: { name: "t", parameters: { properties: {} } } }];
      const tools = run("openrouter", structuredClone(input));
      expect(tools).toEqual(input);
    });
  }
);