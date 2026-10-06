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

/**
 * Parse upstream provider error response
 * @param {Response} response - Fetch response from provider
 * @param {object} [executor] - Optional executor with parseError() override for provider-specific parsing
 * @returns {Promise<{statusCode: number, message: string, resetsAtMs?: number}>}
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
        let bodyJson = null;
        try { bodyJson = JSON.parse(bodyText); } catch { bodyJson = null; }
        return { statusCode: parsed.status || response.status, message: msg, resetsAtMs: parsed.resetsAtMs, bodyText, bodyJson };
      }
    } catch { /* fall through to default parsing */ }
  }

  let message = "";
  let bodyJson = null;
  try {
    const json = JSON.parse(bodyText);
    bodyJson = json;
    message = json.error?.message || json.message || json.error || bodyText;
  } catch {
    message = bodyText;
  }

  const messageStr = typeof message === "string" ? message : JSON.stringify(message);
  const finalMessage = messageStr || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;

  // Honor Groq-style rate-limit reset hints (retry-after / x-ratelimit-reset-*)
  // so callers can block the provider until the window resets.
  const resetsAtMs = parseResetsAtMsFromHeaders(response?.headers);
  if (resetsAtMs) return { statusCode: response.status, message: finalMessage, resetsAtMs, bodyText, bodyJson };
  return { statusCode: response.status, message: finalMessage, bodyText, bodyJson };
}

/**
 * Extract a cooldown expiry (epoch ms) from upstream rate-limit headers.
 * Supports `retry-after` (seconds / HTTP date), Groq `x-ratelimit-reset-*`
 * (delta seconds, epoch seconds, Go durations, HTTP dates). Null when absent.
 */
export function parseResetsAtMsFromHeaders(headers) {
  try {
    if (!headers) return null;
    const get = (name) => {
      try {
        if (typeof headers.get === "function") {
          const v = headers.get(name);
          if (v != null && v !== "") return String(v);
        }
      } catch { /* ignore */ }
      if (typeof headers === "object") {
        for (const k of [name, name.toLowerCase()]) {
          if (headers[k] != null && headers[k] !== "") return String(headers[k]);
        }
      }
      return null;
    };
    const retryAfter = get("retry-after");
    if (retryAfter) {
      const secs = Number.parseFloat(retryAfter);
      if (Number.isFinite(secs) && secs >= 0) return Date.now() + Math.ceil(secs * 1000);
      const asDate = Date.parse(retryAfter);
      if (Number.isFinite(asDate) && asDate > Date.now()) return asDate;
    }
    for (const name of ["x-ratelimit-reset-tokens", "x-ratelimit-reset-requests", "x-ratelimit-reset", "ratelimit-reset"]) {
      const raw = get(name);
      if (!raw) continue;
      const asNum = Number.parseFloat(raw);
      if (Number.isFinite(asNum) && asNum > 0) {
        if (asNum > 1e9) {
          const ms = asNum * 1000;
          if (ms > Date.now()) return ms;
        } else {
          return Date.now() + Math.ceil(asNum * 1000);
        }
      }
      const asDate = Date.parse(raw);
      if (Number.isFinite(asDate) && asDate > Date.now()) return asDate;
      const goMatch = String(raw).match(/(\d+(?:\.\d+)?)(h|m(?!s)|s|ms)/);
      if (goMatch) {
        const val = Number.parseFloat(goMatch[1]);
        const unit = goMatch[2];
        const mult = unit === "h" ? 3600e3 : unit === "m" ? 60e3 : unit === "s" ? 1e3 : 1;
        if (Number.isFinite(val)) return Date.now() + Math.ceil(val * mult);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Create error result for chatCore handler
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {number} [resetsAtMs] - Optional precise cooldown expiry (ms epoch) for provider-specific quota errors
 * @returns {{ success: false, status: number, error: string, response: Response, resetsAtMs?: number }}
 */
export function createErrorResult(statusCode, message, resetsAtMs, extraHeaders = null, extra = {}) {
  return {
    success: false,
    status: statusCode,
    error: message,
    resetsAtMs,
    bodyJson: extra?.bodyJson ?? null,
    classification: extra?.classification ?? null,
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
