/**
 * CodeBuddy 401 self-heal: refreshCredentials must route to the provider refresher.
 * Regression guard for the gap where a dead access token could never be replaced
 * because the executor's refreshers map had no CodeBuddy entry.
 */
import { describe, it, expect, vi } from "vitest";

const refreshIntl = vi.fn(async () => ({ accessToken: "new-intl", refreshToken: "rt-intl", expiresIn: 3600 }));
const refreshCn = vi.fn(async () => ({ accessToken: "new-cn", refreshToken: "rt-cn", expiresIn: 3600 }));

vi.mock("../../open-sse/services/tokenRefresh/providers.js", () => ({
  refreshCodebuddyIntlToken: (...a) => refreshIntl(...a),
  refreshCodebuddyToken: (...a) => refreshCn(...a),
}));

import { DefaultExecutor } from "../../open-sse/executors/default.js";

describe("CodeBuddy token refresh wiring", () => {
  it("refreshes codebuddy-intl credentials", async () => {
    const out = await new DefaultExecutor("codebuddy-intl").refreshCredentials({ refreshToken: "rt-intl" });
    expect(refreshIntl).toHaveBeenCalled();
    expect(out?.accessToken).toBe("new-intl");
  });

  it("refreshes codebuddy-cn credentials", async () => {
    const out = await new DefaultExecutor("codebuddy-cn").refreshCredentials({ refreshToken: "rt-cn" });
    expect(refreshCn).toHaveBeenCalled();
    expect(out?.accessToken).toBe("new-cn");
  });

  it("returns null when no refresh token is stored", async () => {
    refreshIntl.mockClear();
    const out = await new DefaultExecutor("codebuddy-intl").refreshCredentials({ apiKey: "x" });
    expect(out).toBeNull();
    expect(refreshIntl).not.toHaveBeenCalled();
  });
});
