import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  updateProviderConnection: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  updateProviderConnection: mocks.updateProviderConnection,
  getProxyPools: vi.fn().mockResolvedValue([]),
  validateApiKey: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  getAntigravityQuotaCache: () => null,
  handleAntigravityQuotaError: vi.fn(),
  clearAntigravityStrikes: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { getProviderCredentials } = await import("@/sse/services/auth.js");

const CONNECTIONS = [
  { id: "conn-a", provider: "codebuddy-intl", name: "cb", priority: 1, isActive: true, authType: "apikey", apiKey: "k-a", lastUsedAt: null, providerSpecificData: {} },
  { id: "conn-b", provider: "codebuddy-intl", name: "cb2", priority: 2, isActive: true, authType: "apikey", apiKey: "k-b", lastUsedAt: null, providerSpecificData: {} },
  { id: "conn-c", provider: "codebuddy-intl", name: "cb3", priority: 3, isActive: true, authType: "apikey", apiKey: "k-c", lastUsedAt: null, providerSpecificData: {} },
  { id: "conn-d", provider: "codebuddy-intl", name: "cb4", priority: 4, isActive: true, authType: "apikey", apiKey: "k-d", lastUsedAt: null, providerSpecificData: {} },
  { id: "conn-e", provider: "codebuddy-intl", name: "cb5", priority: 5, isActive: true, authType: "apikey", apiKey: "k-e", lastUsedAt: null, providerSpecificData: {} },
];

const SESSION_AFFINITY_SETTINGS = {
  providerStrategies: { "codebuddy-intl": { fallbackStrategy: "session-affinity", sessionAffinity: true } },
  stickyRoundRobinLimit: 2,
  fallbackStrategy: "round-robin",
};

const SESSION_AFFINITY_FLAG_ONLY_SETTINGS = {
  providerStrategies: { "codebuddy-intl": { sessionAffinity: true } },
  stickyRoundRobinLimit: 2,
  fallbackStrategy: "round-robin",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue(SESSION_AFFINITY_SETTINGS);
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  mocks.updateProviderConnection.mockImplementation(async (id, patch) => {
    const conn = CONNECTIONS.find((c) => c.id === id);
    if (conn) Object.assign(conn, patch);
    return conn;
  });
  mocks.getProviderConnections.mockImplementation(async () => CONNECTIONS.map((c) => ({ ...c })));
  // Reset lastUsedAt between tests so LRU order is deterministic
  for (const c of CONNECTIONS) { c.lastUsedAt = null; c.consecutiveUseCount = 0; }
});

describe("session-affinity account selection", () => {
  it("pins one account for every request of the same session", async () => {
    const seen = [];
    for (let turn = 0; turn < 6; turn++) {
      const creds = await getProviderCredentials("codebuddy-intl", null, "deepseek-v4.1-flash", { sessionKey: "session-1" });
      seen.push(creds.connectionId);
    }
    expect(new Set(seen).size).toBe(1);
  });

  it("works via the dashboard flag only (sessionAffinity: true, global round-robin)", async () => {
    mocks.getSettings.mockResolvedValue(SESSION_AFFINITY_FLAG_ONLY_SETTINGS);
    const seen = [];
    for (let turn = 0; turn < 4; turn++) {
      const creds = await getProviderCredentials("codebuddy-intl", null, "deepseek-v4.1-flash", { sessionKey: "session-2" });
      seen.push(creds.connectionId);
    }
    expect(new Set(seen).size).toBe(1);
  });

  it("gives different sessions different accounts when the pool is cold", async () => {
    const a = await getProviderCredentials("codebuddy-intl", null, "deepseek-v4.1-flash", { sessionKey: "session-A" });
    const b = await getProviderCredentials("codebuddy-intl", null, "deepseek-v4.1-flash", { sessionKey: "session-B" });
    const c = await getProviderCredentials("codebuddy-intl", null, "deepseek-v4.1-flash", { sessionKey: "session-C" });
    expect(new Set([a.connectionId, b.connectionId, c.connectionId]).size).toBe(3);
  });

  it("re-pins to a different account when the pinned one is excluded (failover)", async () => {
    const first = await getProviderCredentials("codebuddy-intl", null, "deepseek-v4.1-flash", { sessionKey: "session-1" });
    // Simulate the chat fallback loop: the first account failed → excluded
    const excluded = new Set([first.connectionId]);
    const second = await getProviderCredentials("codebuddy-intl", excluded, "deepseek-v4.1-flash", { sessionKey: "session-1" });
    expect(second.connectionId).not.toBe(first.connectionId);
    const third = await getProviderCredentials("codebuddy-intl", null, "deepseek-v4.1-flash", { sessionKey: "session-1" });
    expect(third.connectionId).toBe(second.connectionId);
  });

  it("falls back to least-recently-used when no session key is available", async () => {
    const first = await getProviderCredentials("codebuddy-intl", null, "deepseek-v4.1-flash", {});
    const second = await getProviderCredentials("codebuddy-intl", null, "deepseek-v4.1-flash", {});
    expect(second.connectionId).not.toBe(first.connectionId);
  });

  it("still rotates when the provider has no session-affinity override", async () => {
    mocks.getSettings.mockResolvedValue({
      providerStrategies: {},
      stickyRoundRobinLimit: 1,
      fallbackStrategy: "round-robin",
    });
    const a = await getProviderCredentials("codebuddy-intl", null, "deepseek-v4.1-flash", { sessionKey: "session-1" });
    const b = await getProviderCredentials("codebuddy-intl", null, "deepseek-v4.1-flash", { sessionKey: "session-1" });
    expect(b.connectionId).not.toBe(a.connectionId);
  });
});
