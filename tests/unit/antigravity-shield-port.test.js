import { describe, expect, it } from "vitest";

import { getVirtualDeviceProfile, sanitizeLogOutput } from "../../open-sse/services/virtualDevice.js";
import { ANTIGRAVITY_LOAD_CODE_ASSIST_HEADERS } from "../../open-sse/config/appConstants.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { canonicalProjectId } from "../../open-sse/services/projectId.js";
import { parseMostRestrictiveBucket, isAntigravityQuotaDrained, _clearQuotaMonitorCache } from "../../open-sse/services/antigravityQuotaMonitor.js";

describe("Antigravity shield port (safe subset)", () => {
  it("generates deterministic isolated virtual device identity", () => {
    const a = getVirtualDeviceProfile("conn-a");
    const a2 = getVirtualDeviceProfile("conn-a");
    const b = getVirtualDeviceProfile("conn-b");
    expect(a.machineId).toMatch(/^[0-9a-f]{64}$/);
    expect(a.deviceUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(a.machineId).toBe(a2.machineId);
    expect(a.machineId).not.toBe(b.machineId);
  });

  it("redacts token-like strings from logs", () => {
    const out = sanitizeLogOutput("ya29.abc123 Bearer tok-xyz GOCSPX-secret456");
    expect(out).not.toContain("ya29.abc123");
    expect(out).not.toContain("Bearer tok-xyz");
    expect(out).not.toContain("GOCSPX-secret456");
    expect(out).toContain("***REDACTED***");
  });

  it("keeps the local loadCodeAssist header policy", () => {
    expect(ANTIGRAVITY_LOAD_CODE_ASSIST_HEADERS["Client-Metadata"]).toBeUndefined();
    expect(ANTIGRAVITY_LOAD_CODE_ASSIST_HEADERS["X-Goog-Api-Client"]).toBeUndefined();
  });

  it("uses canonical deterministic project IDs and replaces legacy fake IDs", () => {
    const ag = new AntigravityExecutor();
    const pid = ag.generateProjectId({ connectionId: "conn-a" });
    expect(pid).toMatch(/^cloudaicompanion-proj-[0-9a-f]{16}$/);
    expect(pid).toBe(canonicalProjectId("conn-a"));
    expect(pid).toBe(ag.generateProjectId({ connectionId: "conn-a" }));
    expect(pid).not.toBe(ag.generateProjectId({ connectionId: "conn-b" }));

    const body = { request: { contents: [{ role: "user", parts: [{ text: "ping" }] }] } };
    const legacy = ag.transformRequest("gemini-2.5-flash", body, true, { connectionId: "conn-a", projectId: "useful-spark-a1b2c" });
    expect(legacy.project).toBe(pid);

    const real = ag.transformRequest("gemini-2.5-flash", body, true, { connectionId: "conn-a", projectId: "my-gcp-project-123" });
    expect(real.project).toBe("my-gcp-project-123");
  });

  it("classifies 403 responses and keeps 429 on the primary host", () => {
    const ag = new AntigravityExecutor();
    expect(ag.shouldRetry(403, 0)).toBe(true);
    expect(ag.shouldRetry(403, 1)).toBe(false);
    expect(ag.shouldRetry(429, 0)).toBe(false);

    const quota = ag.parseError({ status: 403 }, JSON.stringify({ error: { message: "RESOURCE_EXHAUSTED: Quota exceeded" } }));
    expect(quota.code).toBe("QUOTA_EXHAUSTED");
    expect(quota.resetsAtMs).toBeGreaterThan(Date.now());

    expect(ag.parseError({ status: 403 }, "berProxy: Error 403").code).toBe("UPSTREAM_BLOCKED");
    expect(ag.parseError({ status: 403 }, "caller does not have permission").code).toBe("PERMISSION_DENIED");
  });

  it("parses quota summary buckets and fails open on missing inputs", async () => {
    const data = {
      groups: [{
        displayName: "Gemini Pro",
        buckets: [
          { window: "5h", remainingFraction: 0.5, resetTime: "2026-11-24T01:00:00Z" },
          { window: "weekly", remainingFraction: 0.01, resetTime: "2026-11-29T00:00:00Z" },
        ],
      }],
    };
    expect(parseMostRestrictiveBucket(data, "gemini-3-pro")).toEqual({
      remainingFraction: 0.01,
      resetTime: "2026-11-29T00:00:00Z",
    });
    expect(parseMostRestrictiveBucket(null, "gemini-3-pro")).toBeNull();
    _clearQuotaMonitorCache();
    expect(await isAntigravityQuotaDrained("", "gemini-3-pro")).toEqual({ isDrained: false, resetTime: null });
  });
});
