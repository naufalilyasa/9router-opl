import { getCapabilitiesForModel } from "../../providers/capabilities.js";

// Strip request params a given provider/model rejects upstream (e.g. HTTP 400).
// Config-driven: add a rule instead of scattering `delete body.x` across executors.

// Each rule: optional provider, regex match on model, list of params to drop.
// A param is removed only when it is present (!== undefined).
const STRIP_RULES = [
  // All Claude models: temperature deprecated/rejected upstream (Anthropic 400). #1748
  { match: /claude/i, drop: ["temperature"] },
  // GitHub Copilot gpt-5.4: temperature unsupported.
  { provider: "github", match: /gpt-5\.4/i, drop: ["temperature"] },
  // GitHub Copilot Claude (except opus/sonnet 4.6): thinking + reasoning_effort rejected. #713
  { provider: "github", match: (m) => /claude/i.test(m) && !/claude.*(opus|sonnet).*4\.6/i.test(m), drop: ["thinking", "reasoning_effort"] },
  // Cloudflare Workers AI: content must be plain string, rejects OpenAI content-part array (#1926)
  { provider: "cloudflare-ai", flattenContent: true },
  { provider: "volcengine-ark", match: /glm-5/i, clampToModelMaxOutput: true },
  // VolcEngine Ark caps the Kimi family at max_tokens <= 32768, but the model's
  // advertised ceiling is far higher (Kimi-K2.7-Code resolves to maxOutput 262144),
  // so clampToModelMaxOutput alone leaves it uncapped and the request 400s with
  // "integer above maximum value, expected <= 32768". Pin an explicit endpoint cap;
  // min() with the model ceiling still applies if a variant's own limit is lower.
  { provider: "volcengine-ark", match: /kimi/i, maxOutputCap: 32768, clampToModelMaxOutput: true },
  // Strict OpenAI-compatible validators reject unknown assistant-message fields.
  // Clients that talk to reasoning models (e.g. Hermes) echo the prior turn's
  // reasoning back on every assistant message; Groq answers 400 and Mistral 422
  // ("extra_forbidden") on it, which knocks these providers out of every
  // multi-turn combo. Providers that *require* the field (DeepSeek, Kimi) are
  // handled by reasoningContentInjector and are not listed here.
  { provider: "groq", dropMessageFields: ["reasoning_content", "reasoning", "reasoning_details"] },
  { provider: "mistral", dropMessageFields: ["reasoning_content", "reasoning", "reasoning_details"] },
  { provider: "cerebras", dropMessageFields: ["reasoning_content", "reasoning", "reasoning_details"] },
  // CodeBuddy gateways (intl + cn) parse tool_choice as a plain string; OpenAI-style
  // object forms ({"type":"function","function":{name}}, {"type":"auto"}, …) are
  // rejected with 11101 "cannot unmarshal object into … Request.tool_choice of type
  // string". Coerce to the nearest string equivalent; string forms pass untouched.
  { provider: "codebuddy-intl", toolChoiceStringify: true },
  { provider: "codebuddy-cn", toolChoiceStringify: true },
  // CodeBuddy gateways reject tool definitions whose parameters schema lacks
  // `type: "object"` (11129 "invalid function call parameters"). Default the shape.
  { provider: "codebuddy-intl", toolParametersDefaults: true },
  { provider: "codebuddy-cn", toolParametersDefaults: true },
  // OpenCode Zen Go (direct or via sleev-style proxies) runs tool schemas through
  // a Go regexp validator that rejects the `pattern` keyword with
  // "[invalid_request_error] Invalid schema for function '…': … is not a regex".
  // Default the shape and strip the keyword there too.
  { provider: "opencode-go", toolParametersDefaults: true },
];

// Test a rule's match (regex or predicate) against the model id.
function matches(rule, model) {
  if (!rule.match) return true;
  return typeof rule.match === "function" ? rule.match(model) : rule.match.test(model);
}

function clampNumber(body, key, ceiling) {
  if (typeof body[key] === "number" && Number.isFinite(body[key]) && body[key] > ceiling) {
    body[key] = ceiling;
  }
}

// JSON Schema keywords a strict upstream validator rejects. Proven against
// CodeBuddy: `pattern` anywhere inside a tool schema → 400.
const REJECTED_SCHEMA_KEYWORDS = ["pattern"];

// Delete rejected keywords from a tool schema in place, recursing into
// properties/items/combinators. Arrays of primitives (enum, required) are
// left untouched by the object check on their elements.
// Only the string-valued keyword is rejected: a *property named* `pattern`
// (glob/grep declare one) holds a subschema object and must survive intact.
function stripSchemaKeywords(schema) {
  if (Array.isArray(schema)) {
    for (const item of schema) stripSchemaKeywords(item);
    return;
  }
  if (!schema || typeof schema !== "object") return;
  for (const key of REJECTED_SCHEMA_KEYWORDS) {
    if (typeof schema[key] === "string") delete schema[key];
  }
  for (const value of Object.values(schema)) stripSchemaKeywords(value);
}

// Remove unsupported params from body in place; returns body.
export function stripUnsupportedParams(provider, model, body) {
  if (!model || !body || typeof body !== "object") return body;
  for (const rule of STRIP_RULES) {
    if (rule.provider && rule.provider !== provider) continue;
    if (!matches(rule, model)) continue;
    for (const key of rule.drop || []) {
      if (body[key] !== undefined) delete body[key];
    }
    // Per-message field drop (assistant turns only — that is where clients replay reasoning).
    if (Array.isArray(rule.dropMessageFields) && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (!msg || msg.role !== "assistant") continue;
        for (const key of rule.dropMessageFields) {
          if (msg[key] !== undefined) delete msg[key];
        }
      }
    }
    // CF Workers AI oneOf root schema only accepts content as plain string (#1926)
    if (rule.flattenContent && Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (msg && Array.isArray(msg.content)) {
          msg.content = msg.content
            .map(b => (b?.type === "text" && typeof b.text === "string") ? b.text : "")
            .join("");
        }
      }
    }
    // CodeBuddy gateways: object tool_choice → nearest string enum (upstream parses a string only)
    if (rule.toolChoiceStringify && body.tool_choice && typeof body.tool_choice === "object") {
      const kind = body.tool_choice.type;
      body.tool_choice = kind === "function" || kind === "tool" || kind === "any"
        ? "required"
        : kind === "auto" || kind === "none" || kind === "required"
          ? kind
          : "auto";
    }
    // CodeBuddy gateways: every tool parameters schema needs `type: "object"`,
    // and the `pattern` keyword is rejected anywhere inside a tool schema.
    if (rule.toolParametersDefaults && Array.isArray(body.tools)) {
      for (const tool of body.tools) {
        if (!tool || typeof tool !== "object") continue;
        const holder = tool.function && typeof tool.function === "object" ? tool.function : tool;
        const schema = holder.parameters;
        if (schema === undefined || schema === null) {
          holder.parameters = { type: "object", properties: {} };
        } else if (typeof schema === "object" && !Array.isArray(schema)) {
          if (schema.type === undefined) schema.type = "object";
          if (schema.properties === undefined) schema.properties = {};
          stripSchemaKeywords(schema);
        }
      }
    }
    if (rule.clampToModelMaxOutput || Number.isFinite(rule.maxOutputCap)) {
      const modelCeiling = getCapabilitiesForModel(provider, model).maxOutput;
      const candidates = [];
      if (rule.clampToModelMaxOutput && Number.isFinite(modelCeiling) && modelCeiling > 0) {
        candidates.push(modelCeiling);
      }
      if (Number.isFinite(rule.maxOutputCap) && rule.maxOutputCap > 0) {
        candidates.push(rule.maxOutputCap);
      }
      if (candidates.length > 0) {
        const ceiling = Math.min(...candidates);
        clampNumber(body, "max_tokens", ceiling);
        clampNumber(body, "max_completion_tokens", ceiling);
        clampNumber(body, "max_output_tokens", ceiling);
      }
    }
  }
  return body;
}
