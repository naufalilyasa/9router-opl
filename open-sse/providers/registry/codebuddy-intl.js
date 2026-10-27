// CodeBuddy international (codebuddy.ai) — mirrors codebuddy-cn registry shape,
// swapping the Tencent CN domain for the .ai endpoint set. All OAuth/plugin URLs
// use the /v2/plugin prefix with platform=ide (CN uses platform=CLI).
export default {
  id: "codebuddy-intl",
  alias: "cbai",
  uiAlias: "cbai",
  hidden: false,
  priority: 90,
  display: {
    name: "CodeBuddy",
    icon: "smart_toy",
    color: "#006EFF",
    website: "https://www.codebuddy.ai",
    notice: {
      signupUrl: "https://www.codebuddy.ai",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    // Chat gateway is OpenAI-compatible SSE (same /v2/chat/completions path as CN).
    baseUrl: "https://www.codebuddy.ai/v2/chat/completions",
    forceStream: true,
    // CodeBuddy intl speaks the same unified OpenAI reasoning_effort shape as CN.
    thinkingFormat: "openai",
    headers: {
      "User-Agent": "IDE/2.108.1 CodeBuddy/2.108.1",
      "X-Product": "SaaS",
      "X-IDE-Type": "IDE",
      "X-IDE-Name": "IDE",
      "x-requested-with": "XMLHttpRequest",
      "x-codebuddy-request": "1",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
      // Channel check requires the plugin's request/conversation ids — without
      // them upstream rejects with 400 / 11128 "request illegal".
      hooks: ["codebuddyHeaders"],
    },
    // Intl billing endpoint mirrors CN shape (data.Response.Data.Accounts[]).
    usage: {
      url: "https://www.codebuddy.ai/v2/billing/meter/get-user-resource",
    },
  },
  // The intl gateway serves the same backend catalog as CN, but publishes a
  // different id set. Verified 2026-10-19 against www.codebuddy.ai directly
  // (bypassing 9router, healthy account, full X-Conversation-* header family):
  // a retired id answers 400 code 11102 "model [X] service info not found" in
  // 40-70ms — deterministic, so it is a catalog removal, not throttling. The
  // live ids answer 200. Keep this list to what actually serves; an id that
  // only 11102s stays advertised forever because 11102 never cools down.
  //
  // Drop log (all 400/11102, verified twice, 3 consecutive calls each):
  //   glm-4.7, glm-5.0-turbo, minimax-m2.7, hy3-preview, deepseek-v3-2-volc,
  //   deepseek-v4-pro, kimi-k3-1, deepseek-v4-flash
  // Note kimi-k3-1 is a CN-only id; intl publishes kimi-k3 instead.
  models: [
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "glm-5.1", name: "GLM-5.1" },
    // glm-5.0 still serves but is chronically 429/14003 "Model busy"; kept
    // because the block is upstream load, not a catalog change.
    { id: "glm-5.0", name: "GLM-5.0" },
    { id: "glm-5v-turbo", name: "GLM-5v-Turbo" },
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash" },
    { id: "minimax-m3", name: "MiniMax-M3" },
    { id: "kimi-k2.7", name: "Kimi-K2.7-Code" },
    { id: "kimi-k2.6", name: "Kimi-K2.6" },
    { id: "kimi-k2.5", name: "Kimi-K2.5" },
    { id: "kimi-k2.8-preview", name: "Kimi-K2.8-Preview" },
    { id: "kimi-k3", name: "Kimi-K3" },
    { id: "hy3", name: "Hy3" },
    { id: "hy4-preview", name: "Hy4-Preview" },
    // deepseek-v4-flash replaced server-side by deepseek-v4.1-flash; the old
    // id now 11102s rather than answering 200.
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash" },
  ],
  oauth: {
    baseUrl: "https://www.codebuddy.ai",
    stateUrl: "https://www.codebuddy.ai/v2/plugin/auth/state",
    tokenUrl: "https://www.codebuddy.ai/v2/plugin/auth/token",
    refreshUrl: "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
    userAgent: "IDE/2.63.2 CodeBuddy/2.63.2",
    platform: "ide",
    pollInterval: 5000,
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};
