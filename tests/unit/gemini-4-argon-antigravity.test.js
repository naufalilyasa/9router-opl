import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import antigravityRegistry from "../../open-sse/providers/registry/antigravity.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";

describe("Gemini 4 Argon Support & Config", () => {
  it("registers gemini-4-argon tiered models in antigravity provider registry", () => {
    const agIds = antigravityRegistry.models.map((m) => m.id);
    expect(agIds).toContain("gemini-4-argon-high");
    expect(agIds).toContain("gemini-4-argon-medium");
    expect(agIds).toContain("gemini-4-argon-low");
    expect(agIds).toContain("gemini-4-argon");
  });

  it("maps upstream model IDs correctly", () => {
    const models = Object.fromEntries(antigravityRegistry.models.map((m) => [m.id, m.upstreamModelId]));
    expect(models["gemini-4-argon-high"]).toBe("gemini-4-argon-high(high)");
    expect(models["gemini-4-argon-medium"]).toBe("gemini-4-argon-medium(medium)");
    expect(models["gemini-4-argon-low"]).toBe("gemini-4-argon-low(low)");
    expect(models["gemini-4-argon"]).toBe("gemini-4-argon-medium(medium)");
  });

  it("resolves capabilities correctly for gemini-4-argon models with official limits", () => {
    const caps = getCapabilitiesForModel("antigravity", "gemini-4-argon-high");
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("gemini-level");
    expect(caps.thinkingCanDisable).toBe(false);
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(65536);
  });

  it("resolves gemini-4 pricing from the gemini-4 pattern", () => {
    // v0.5.119 (#4c7804ef) bills gemini-4 at its real rate (2.00/10.00);
    // the explicit argon entries this test used to pin were that rate's predecessor.
    const expected = { input: 2.00, output: 10.00, cached: 0.10, reasoning: 10.00, cache_creation: 0.1875 };
    for (const id of ["gemini-4-argon", "gemini-4-argon-high", "gemini-4-argon-medium", "gemini-4-argon-low"]) {
      expect(getPricingForModel("antigravity", id)).toEqual(expected);
    }
  });
});
