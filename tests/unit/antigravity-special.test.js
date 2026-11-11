import { describe, it, expect } from "vitest";
import { parseModel, resolveProviderAlias } from "open-sse/services/model.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { getExecutor } from "open-sse/executors/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "open-sse/providers/index.js";
import { resolveProviderId } from "@/shared/constants/providers.js";

describe("Antigravity Special (ags) parity with Antigravity (ag)", () => {
  it("resolves ags alias and model parsing", () => {
    expect(resolveProviderAlias("ags")).toBe("antigravity-special");
    expect(resolveProviderId("ags")).toBe("antigravity-special");

    const parsed = parseModel("ags/gemini-4-argon-high");
    expect(parsed).toEqual({
      provider: "antigravity-special",
      model: "gemini-4-argon-high",
      isAlias: false,
      providerAlias: "ags",
    });
  });

  it("exposes identical format and transport settings", () => {
    expect(PROVIDERS["antigravity-special"]).toBeDefined();
    expect(PROVIDERS["antigravity-special"].format).toBe("antigravity");
    expect(PROVIDERS["antigravity-special"].baseUrls).toEqual(PROVIDERS.antigravity.baseUrls);
    expect(PROVIDERS["antigravity-special"].headers).toEqual(PROVIDERS.antigravity.headers);
  });

  it("exposes all identical models under ags", () => {
    expect(PROVIDER_MODELS.ags).toBeDefined();
    expect(PROVIDER_MODELS.ags.length).toBe(PROVIDER_MODELS.ag.length);

    const agIds = PROVIDER_MODELS.ag.map((m) => m.id);
    const agsIds = PROVIDER_MODELS.ags.map((m) => m.id);
    expect(agsIds).toEqual(agIds);
  });

  it("maintains 100% capability and thinking level parity for models", () => {
    const testModels = [
      "gemini-4-argon-high",
      "gemini-4-argon",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash",
      "claude-sonnet-5-5-high",
    ];

    for (const model of testModels) {
      const agCaps = getCapabilitiesForModel("antigravity", model);
      const agsCaps = getCapabilitiesForModel("antigravity-special", model);
      expect(agsCaps).toEqual(agCaps);

      const agLevels = getThinkingLevels("antigravity", model);
      const agsLevels = getThinkingLevels("antigravity-special", model);
      expect(agsLevels).toEqual(agLevels);
    }
  });

  it("provides AntigravityExecutor with identical configuration", () => {
    const exec = getExecutor("antigravity-special");
    expect(exec).toBeDefined();
    expect(exec.provider).toBe("antigravity-special");
    expect(exec.constructor.name).toBe("AntigravityExecutor");
  });
});
