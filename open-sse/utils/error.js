import { ERROR_TYPES, DEFAULT_ERROR_MESSAGES } from "../config/errorConfig.js";

/**
 * Build OpenAI-compatible error response body
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {object} Error response object
 */
export function buildErrorBody(statusCode, message) {
  const errorInfo = ERROR_TYPES[statusCode] || 
    (statusCode >= 500 
      ? { type: "server_error", code: "internal_server_error" }
      : { type: "invalid_request_error", code: "" });

  return {
    error: {
      message: message || DEFAULT_ERROR_MESSAGES[statusCode] || "An error occurred",
      type: errorInfo.type,
      code: errorInfo.code
    }
  };
}

/**
 * Create error Response object (for non-streaming)
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @returns {Response} HTTP Response object
 */
export function errorResponse(statusCode, message, extraHeaders = null) {
  return new Response(JSON.stringify(buildErrorBody(statusCode, message)), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders
    }
  });
}

/**
 * Write error to SSE stream (for streaming)
 * @param {WritableStreamDefaultWriter} writer - Stream writer
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 */
export async function writeStreamError(writer, statusCode, message) {
  const errorBody = buildErrorBody(statusCode, message);
  const encoder = new TextEncoder();
  await writer.write(encoder.encode(`data: ${JSON.stringify(errorBody)}\n\n`));
}

function parseRetryHeaders(headers) {
  if (!headers || typeof headers.get !== "function") return null;

  const retryAfter = headers.get("retry-after") || headers.get("x-ratelimit-reset-after");
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds) && seconds > 0) return Date.now() + seconds * 1000;

    const date = new Date(retryAfter);
    if (!isNaN(date.getTime()) && date.getTime() > Date.now()) {
      return date.getTime();
    }
  }

  const resetTimestamp = headers.get("x-ratelimit-reset");
  if (resetTimestamp) {
    const sec = parseInt(resetTimestamp, 10);
    if (!isNaN(sec) && sec > 0) {
      const ms = sec > 1e11 ? sec : sec * 1000;
      if (ms > Date.now()) return ms;
    }
  }

  return null;
}

function parseResetFromText(text) {
  if (!text || typeof text !== "string") return null;
  // Format 1: "reset after 1h2m3s" or "resets after 30s"
  const m1 = text.match(/resets?\s+after\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
  if (m1 && (m1[1] || m1[2] || m1[3])) {
    const ms = ((parseInt(m1[1], 10) || 0) * 3600 + (parseInt(m1[2], 10) || 0) * 60 + (parseInt(m1[3], 10) || 0)) * 1000;
    if (ms > 0) return Date.now() + ms;
  }
  // Format 2: "try again in 5 minutes" / "retry in 30 seconds" / "wait 10m"
  const m2 = text.match(/(?:try again|retry|wait)\s+(?:in\s+)?(\d+)\s*(s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?|h(?:our?s?)?)/i);
  if (m2) {
    const val = parseInt(m2[1], 10);
    const unit = m2[2].toLowerCase()[0];
    const mult = unit === "h" ? 3600 : (unit === "m" ? 60 : 1);
    if (val > 0) return Date.now() + val * mult * 1000;
  }
  return null;
}

/**
 * Parse upstream provider error response
 * @param {Response} response - Fetch response from provider
 * @param {object} [executor] - Optional executor with parseError() override for provider-specific parsing
 * @returns {Promise<{statusCode: number, message: string, resetsAtMs?: number, scope?: string}>}
 */
export async function parseUpstreamError(response, executor = null) {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  // Let executor-specific parser extract provider-specific fields (e.g. codex resetsAtMs)
  if (executor && typeof executor.parseError === "function") {
    try {
      const parsed = executor.parseError(response, bodyText);
      if (parsed && typeof parsed === "object") {
        const msg = parsed.message || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;
        let resetsAtMs = parsed.resetsAtMs;
        if (!resetsAtMs) {
          resetsAtMs = parseRetryHeaders(response?.headers) || parseResetFromText(msg);
        }
        return { statusCode: parsed.status || response.status, message: msg, resetsAtMs, scope: parsed.scope };
      }
    } catch { /* fall through to default parsing */ }
  }

  let message = "";
  try {
    const json = JSON.parse(bodyText);
    message = json.error?.message || json.message || json.error || bodyText;
  } catch {
    message = bodyText;
  }

  const messageStr = typeof message === "string" ? message : JSON.stringify(message);
  const finalMessage = messageStr || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;

  let resetsAtMs = parseRetryHeaders(response?.headers) || parseResetFromText(finalMessage);

  return { statusCode: response.status, message: finalMessage, resetsAtMs };
}

/**
 * Create error result for chatCore handler
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {number} [resetsAtMs] - Optional precise cooldown expiry (ms epoch) for provider-specific quota errors
 * @param {object} [extraHeaders] - Optional headers
 * @param {string} [scope] - Optional scope e.g. "account"
 * @returns {{ success: false, status: number, error: string, response: Response, resetsAtMs?: number, scope?: string }}
 */
export function createErrorResult(statusCode, message, resetsAtMs, extraHeaders = null, scope = null) {
  return {
    success: false,
    status: statusCode,
    error: message,
    resetsAtMs,
    scope,
    response: errorResponse(statusCode, message, extraHeaders)
  };
}

/**
 * Create unavailable response when all accounts are rate limited
 * @param {number} statusCode - Original error status code
 * @param {string} message - Error message (without retry info)
 * @param {string} retryAfter - ISO timestamp when earliest account becomes available
 * @param {string} retryAfterHuman - Human-readable retry info e.g. "reset after 30s"
 * @returns {Response}
 */
export function unavailableResponse(statusCode, message, retryAfter, retryAfterHuman, extraHeaders = null) {
  const retryAfterSec = Math.max(Math.ceil((new Date(retryAfter).getTime() - Date.now()) / 1000), 1);
  const msg = `${message} (${retryAfterHuman})`;
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    {
      status: statusCode,
      headers: {
        ...extraHeaders,
        "Content-Type": "application/json",
        // Intentionally mis-cased to prevent duplicate headers
        "retry-after": String(retryAfterSec)
      }
    }
  );
}

/**
 * Format provider error with context
 * @param {Error} error - Original error
 * @param {string} provider - Provider name
 * @param {string} model - Model name
 * @param {number|string} statusCode - HTTP status code or error code
 * @returns {string} Formatted error message
 */
export function formatProviderError(error, provider, model, statusCode) {
  const code = statusCode || error.code || "FETCH_FAILED";
  const message = error.message || "Unknown error";
  // Expose low-level cause (e.g. UND_ERR_SOCKET, ECONNRESET, ETIMEDOUT) for diagnosing fetch failures
  const causeCode = error.cause?.code;
  const causeMsg = error.cause?.message;
  const causeStr = causeCode || causeMsg ? ` (cause: ${[causeCode, causeMsg].filter(Boolean).join(": ")})` : "";
  return `[${code}]: ${message}${causeStr}`;
}
