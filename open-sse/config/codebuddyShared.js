// Shared CodeBuddy (CN + intl) request normalization, ported from upstream PR #5342.
// The gateway's channel check expects the WorkBuddy/IDE identity on API-key
// connections; OAuth connections keep their registry identity.

const WORKBUDDY_VERSION = "5.9.3";

export function codeBuddyApiKeyHeaders(apiKey, intl = false) {
  const key = String(apiKey || "").trim();
  return {
    "X-API-Key": key,
    // The gateway expects an anonymous identity for key-based connections.
    // Only the last 8 chars are used, matching the upstream client's contract.
    "X-User-Id": `anonymous_${key.slice(-8)}`,
    "X-Product": "SaaS",
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Version": WORKBUDDY_VERSION,
    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",
    "X-Agent-Type": "main",
    "X-Agent-Runtime": "local-agent",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": intl
      ? `WorkBuddy/${WORKBUDDY_VERSION} workbuddy-ai/${WORKBUDDY_VERSION} CLI/2.165.0`
      : `WorkBuddy/${WORKBUDDY_VERSION} WorkBuddy/${WORKBUDDY_VERSION} CLI/2.165.0`,
  };
}

// Clients that echo assistant reasoning in `reasoning_content` /
// `reasoning_details` lose it on the next turn unless it is folded back into
// the OpenAI `reasoning` field the CodeBuddy gateway reads.
export function normalizeCodeBuddyReasoning(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (!message || message.role !== "assistant") return message;
    const reasoning =
      typeof message.reasoning_content === "string" && message.reasoning_content
        ? message.reasoning_content
        : Array.isArray(message.reasoning_details)
          ? message.reasoning_details
            .map((d) => (typeof d?.text === "string" ? d.text : typeof d?.summary === "string" ? d.summary : ""))
            .join("")
          : "";
    if (!reasoning || (typeof message.reasoning === "string" && message.reasoning)) return message;
    const next = { ...message, reasoning };
    delete next.reasoning_content;
    delete next.reasoning_details;
    return next;
  });
}
