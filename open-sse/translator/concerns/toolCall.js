// Tool call helper functions for translator

import { FORMATS } from "../formats.js";

// Anthropic tool_use.id must match: ^[a-zA-Z0-9_-]+$
const TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Fallback streaming tool_call id when provider omits one (index optional)
export function fallbackToolCallId(index) {
  return index === undefined ? `call_${Date.now()}` : `call_${index}_${Date.now()}`;
}

// Generate deterministic tool call ID from position + tool name (cache-friendly)
export function generateToolCallId(msgIndex = 0, tcIndex = 0, toolName = "") {
  const name = toolName ? `_${toolName.replace(/[^a-zA-Z0-9_-]/g, "")}` : "";
  return `call_msg${msgIndex}_tc${tcIndex}${name}`;
}

// Sanitize ID to match Anthropic pattern: keep only alphanumeric, underscore, hyphen
function sanitizeToolId(id) {
  if (!id || typeof id !== "string") return null;
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return sanitized.length > 0 ? sanitized : null;
}

// Ensure all tool_calls have valid id field and arguments is string (some providers require it)
export function ensureToolCallIds(body) {
  if (!body.messages || !Array.isArray(body.messages)) return body;

  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    if (msg.role === "assistant" && msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (let j = 0; j < msg.tool_calls.length; j++) {
        const tc = msg.tool_calls[j];
        // Validate or regenerate ID for Anthropic compatibility
        if (!tc.id || !TOOL_ID_PATTERN.test(tc.id)) {
          const sanitized = sanitizeToolId(tc.id);
          tc.id = sanitized || generateToolCallId(i, j, tc.function?.name);
        }
        if (!tc.type) {
          tc.type = "function";
        }
        // Ensure arguments is JSON string, not object
        if (tc.function?.arguments && typeof tc.function.arguments !== "string") {
          tc.function.arguments = JSON.stringify(tc.function.arguments);
        }
      }
    }

    // Validate tool_call_id in tool messages (role: "tool")
    if (msg.role === "tool" && msg.tool_call_id && !TOOL_ID_PATTERN.test(msg.tool_call_id)) {
      const sanitized = sanitizeToolId(msg.tool_call_id);
      msg.tool_call_id = sanitized || generateToolCallId(i, 0);
    }

    // Also validate tool_use blocks in content (Claude format)
    if (Array.isArray(msg.content)) {
      for (let k = 0; k < msg.content.length; k++) {
        const block = msg.content[k];
        if (block.type === "tool_use" && block.id && !TOOL_ID_PATTERN.test(block.id)) {
          const sanitized = sanitizeToolId(block.id);
          block.id = sanitized || generateToolCallId(i, k, block.name);
        }
        // Validate tool_use_id in tool_result blocks
        if (block.type === "tool_result" && block.tool_use_id && !TOOL_ID_PATTERN.test(block.tool_use_id)) {
          const sanitized = sanitizeToolId(block.tool_use_id);
          block.tool_use_id = sanitized || generateToolCallId(i, k);
        }
      }
    }
  }

  return body;
}

// Get tool_call ids from assistant message (OpenAI format: tool_calls, Claude format: tool_use in content)
export function getToolCallIds(msg) {
  if (msg.role !== "assistant") return [];

  const ids = [];

  // OpenAI format: tool_calls array
  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc.id) ids.push(tc.id);
    }
  }

  // Claude format: tool_use blocks in content
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "tool_use" && block.id) {
        ids.push(block.id);
      }
    }
  }

  return ids;
}

// Synthetic result content for a tool_call left without a response (history truncation,
// cancelled/timeout parallel call). Upstream CodeBuddy/Tencent accepts a role:tool result
// with an explicit error payload, so the model sees a real (failed) result instead of a
// structurally invalid graph. See codebuddy-intl/cn 11133 / 11148.
const OMITTED_TOOL_RESULT = '{"error":"Tool execution omitted or cancelled"}';

// Fix missing tool responses: repair the tool-call graph so every id a provider sees is
// answered. The legacy immediate-next check missed two cases that upstream rejects with a
// generic 400 (CodeBuddy `11133 model_param_invalid`, cbcn `11148 tool calls and tool
// results do not match`):
//   - an assistant tool_calls block as the LAST message (no next msg -> repair skipped)
//   - parallel tool_calls answered only partially (any match counted as complete)
// Also drops orphan role:tool messages whose id was never requested.
//
// Shape-aware: OpenAI bodies (assistant.tool_calls + role:tool) get synthetic role:tool
// messages; Claude bodies (assistant content tool_use + user content tool_result) get
// synthetic tool_result blocks, so a Claude source body is not corrupted before it is
// translated. Bodies without a tool graph are returned untouched.
export function fixMissingToolResponses(body) {
  if (!body.messages || !Array.isArray(body.messages)) return body;

  const newMessages = [];
  let pending = new Map();

  const flush = () => {
    for (const [id, info] of pending) {
      if (info.claude) {
        const carrier = newMessages[newMessages.length - 1];
        const block = { type: "tool_result", tool_use_id: id, content: OMITTED_TOOL_RESULT };
        if (carrier && carrier.role === "user" && Array.isArray(carrier.content)) {
          carrier.content.push(block);
        } else {
          newMessages.push({ role: "user", content: [block] });
        }
      } else {
        newMessages.push({ role: "tool", tool_call_id: id, content: OMITTED_TOOL_RESULT });
      }
    }
    pending = new Map();
  };

  for (const msg of body.messages) {
    if (!msg || typeof msg !== "object") continue;

    const idSet = new Set(getToolCallIds(msg));

    if (msg.role === "assistant" && idSet.size > 0) {
      flush();
      newMessages.push(msg);
      const claude = Array.isArray(msg.content) && msg.content.some((b) => b?.type === "tool_use");
      for (const id of idSet) pending.set(id, { claude });
    } else if (msg.role === "assistant") {
      flush();
      newMessages.push(msg);
    } else if (msg.role === "tool") {
      if (msg.tool_call_id && pending.has(msg.tool_call_id)) {
        pending.delete(msg.tool_call_id);
        newMessages.push(msg);
      }
    } else if (msg.role === "user" && Array.isArray(msg.content) && msg.content.some((b) => b?.type === "tool_result")) {
      // Claude results ride in user messages. Keep a user message only if it still has a
      // matched tool_result or non-tool_result content; drop it when it becomes empty so an
      // orphan result cannot leave an empty user message before a user turn.
      const keptBlocks = msg.content.filter((b) => {
        if (b?.type !== "tool_result") return true;
        if (b.tool_use_id && pending.has(b.tool_use_id)) {
          pending.delete(b.tool_use_id);
          return true;
        }
        return false;
      });
      if (keptBlocks.length > 0) newMessages.push({ ...msg, content: keptBlocks });
    } else {
      flush();
      newMessages.push(msg);
    }
  }

  flush();
  body.messages = newMessages;
  return body;
}

// Default `type: "custom"` on Claude-format tools that arrive without one.
// Anthropic's Claude tool schema requires `type` to be explicitly set; strict gateways
// (e.g., MiniMax Anthropic-compatible endpoint, error 2013) reject legacy payloads that
// omit it with HTTP 400. Tools that already carry a truthy `type` (e.g., `computer_use`,
// `bash`, `web_search_20250305`) are passed through untouched.
//
// Spread order matters: `{ ...tool, type: "custom" }` (spread first, override last)
// ensures that falsy `type` values (null, undefined, "") in the original tool don't
// overwrite the default. `{ type: "custom", ...tool }` would let `type: null` survive.
export function defaultClaudeToolType(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map(tool => tool?.type ? tool : { ...tool, type: "custom" });
}

// Whether Claude-format tools need explicit `type` defaulting before dispatch.
// Only gateways that declare the `requireClaudeToolType` quirk (MiniMax) reject typeless
// tools. Applying the default globally breaks Claude-format endpoints that only accept the
// legacy typeless tool shape — DeepSeek's Anthropic-compatible endpoint answers HTTP 400
// "unknown variant `custom`" and every Claude Code request routed there fails (#3905).
export function shouldDefaultClaudeToolType(provider, finalFormat, tools, PROVIDERS) {
  return (
    finalFormat === FORMATS.CLAUDE
    && Array.isArray(tools)
    && PROVIDERS?.[provider]?.quirks?.requireClaudeToolType === true
  );
}

