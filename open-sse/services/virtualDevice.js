import crypto from "crypto";

/**
 * Deterministic virtual device profile for Antigravity connections.
 * Identity stays in request metadata (not headers) so the local header policy
 * remains unchanged.
 */
export function getVirtualDeviceProfile(connectionIdOrSeed) {
  const seed = String(connectionIdOrSeed || "antigravity:default:seed");
  const machineId = crypto.createHash("sha256").update(`machine:${seed}`).digest("hex");

  const bytes = crypto.createHash("sha256").update(`device-uuid:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const deviceUuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

  return { machineId, deviceUuid };
}

export function sanitizeLogOutput(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/ya29\.[a-zA-Z0-9_\-]+/g, "ya29.***REDACTED***")
    .replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, "Bearer ***REDACTED***")
    .replace(/GOCSPX-[a-zA-Z0-9_\-]+/g, "GOCSPX-***REDACTED***");
}
