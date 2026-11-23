/**
 * Focused tests for the native FreePI port (xrouter 8d12fd6).
 * No network calls: handshake/queue primitives and wiring only.
 */
import { describe, it, expect, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

import { FreePiExecutor, launchSessionHandshake, acquireFreePiQueueLock } from "../../open-sse/executors/freepi.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";

describe("FreePI native port", () => {
  it("registers provider and both aliases", () => {
    expect(PROVIDERS.freepi).toBeDefined();
    expect(PROVIDERS.freepi.baseUrl).toBe("https://api.freepi.ai/v1/chat/completions");
    expect(PROVIDERS.freepi.validateUrl).toBe("https://api.freepi.ai/me/stats");
    expect(PROVIDER_MODELS.fp).toBeDefined();
    expect(PROVIDER_MODELS.fp.some((m) => m.id === "particle")).toBe(true);
  });

  it("registers freepi in the provider registry with fp alias", () => {
    const entry = REGISTRY.find((p) => p.id === "freepi");
    expect(entry).toBeDefined();
    expect(entry.alias).toBe("fp");
    expect(entry.aliases).toContain("free-pi");
  });

  it("adds client fingerprint headers with configurable CLI version", () => {
    const headers = new FreePiExecutor().buildHeaders({ apiKey: "fake-token" });
    expect(headers["x-client-version"]).toBe(process.env.FREEPI_CLI_VERSION || "0.6.26");
    expect(headers["x-session-id"]).toBeTruthy();
    expect(headers["x-turn-id"]).toBeTruthy();
    expect(headers["x-ad-context"]).toBe("none");
    expect(headers.Authorization).toBe("Bearer fake-token");
  });

  it("handshake is a safe no-op for an empty token", async () => {
    expect(await launchSessionHandshake("")).toBe(false);
  });

  it("serialises queue acquisition in FIFO order", async () => {
    const token = `test-freepi-${Date.now()}`;
    const order = [];
    let release1 = await acquireFreePiQueueLock(token);
    order.push("req1");
    const p2 = acquireFreePiQueueLock(token).then(async (rel2) => {
      order.push("req2");
      await rel2();
    });
    await release1();
    await p2;
    expect(order).toEqual(["req1", "req2"]);
  });
});
