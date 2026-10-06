import { parseResetsAtMsFromHeaders } from "./error.js";

// Canonical error types for fallback decisions.
export const CLASSIFIED_TYPES = {
  INVALID_CREDENTIALS: "invalid_credentials",
  QUOTA_EXHAUSTED: "quota_exhausted",
  UPSTREAM_OVERLOAD: "upstream_overload",
  UPSTREAM_RATE_LIMIT: "upstream_rate_limit",
  CONCURRENCY_LIMIT: "concurrency_limit",
  GATEWAY_RATE_LIMIT: "gateway_rate_limit",
  TIMEOUT: "timeout",
  SERVER_ERROR: "server_error",
  INVALID_REQUEST: "invalid_request",
  UNKNOWN: "unknown",
};

export const CLASSIFIED_SCOPES = {
  ACCOUNT: "account",
  MODEL: "model",
  PROVIDER: "provider",
  GATEWAY: "gateway",
};

// Long/short cooldown policy (single place).
export const ACCOUNT_INVALID_COOLDOWN_MS = 30 * 60 * 1000; // 401 → 30min
export const QUOTA_EXHAUSTED_DEFAULT_MS = 6 * 60 * 60 * 1000; // daily quota w/o header → 6h
export const UPSTREAM_BACKOFF_MIN_MS = 1000;
export const UPSTREAM_BACKOFF_MAX_MS = 5000;

const DAILY_QUOTA_PATTERNS = [
  "free model daily limit reached",
  "daily limit",
  "quota exceeded",
  "top up credits",
  "top-up credits",
  "free version",
  "usage_limit_reached",
  "monthly limit",
  "plan limit",
  "additional usage limit",
];

const UPSTREAM_PATTERNS = [
  "server overload",
  "temporarily rate-limited upstream",
  "request limited concurrency reached",
  "provider returned error",
  "upstream_provider_account",
  "is_byok",
  "remedy_hint",
];

function toLowerText(v) {
  try {
    if (!v) return "";
    if (typeof v === "string") return v.toLowerCase();
    return JSON.stringify(v).toLowerCase();
  } catch {
    return String(v || "").toLowerCase();
  }
}

function tryParseJson(text) {
  if (!text) return null;
  if (typeof text === "object") return text;
  try {
    const j = JSON.parse(String(text));
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

// Extract Kilo-style envelope: provider_name / limit_source / remedy_hint / metadata.
function extractUpstreamEnvelope(bodyJson, bodyText) {
  const lower = toLowerText(bodyText);
  const j = bodyJson || tryParseJson(bodyText) || {};
  // Body may nest under error.{provider_name,metadata,...} or top-level.
  const err = j?.error && typeof j.error === "object" ? j.error : {};
  const merged = { ...j, ...err };
  const metadata = merged?.metadata && typeof merged.metadata === "object" ? merged.metadata :
    j?.metadata && typeof j.metadata === "object" ? j.metadata : null;
  const providerName =
    merged?.provider_name || merged?.providerName || merged?.provider ||
    metadata?.provider_name || metadata?.providerName || metadata?.provider || null;
  const limitSource = merged?.limit_source || merged?.limitSource || metadata?.limit_source || null;
  const remedyHint = merged?.remedy_hint || merged?.remedyHint || metadata?.remedy_hint || null;
  const isByok =
    merged?.is_byok === true || merged?.isByok === true ||
    metadata?.is_byok === true || metadata?.isByok === true ||
    lower.includes("is_byok");
  // "current: 401, limit: 400" style concurrency counters.
  let current = null;
  let limit = null;
  const clMatch = lower.match(/current\s*[:=]\s*(\d+)[^0-9]+limit\s*[:=]\s*(\d+)/);
  if (clMatch) {
    current = Number.parseInt(clMatch[1], 10);
    limit = Number.parseInt(clMatch[2], 10);
  }
  const hasEnvelope =
    providerName != null || limitSource != null || remedyHint != null || isByok ||
    lower.includes("provider_name") || lower.includes("limit_source") || lower.includes("remedy_hint");
  return { providerName: providerName ? String(providerName) : null, limitSource: limitSource ? String(limitSource) : null, remedyHint: remedyHint ? String(remedyHint) : null, isByok, current, limit, metadata, hasEnvelope };
}

function headerRetryAfterMs(headers) {
  try {
    return parseResetsAtMsFromHeaders(headers) || null;
  } catch {
    return null;
  }
}

/**
 * Classify an upstream failure into a canonical type + lock scope.
 * Uses status, message/body, envelope fields (provider_name/limit_source/
 * remedy_hint/metadata) and rate-limit headers.
 */
export function classifyError({ status, bodyText = "", bodyJson = null, headers = null } = {}) {
  const s = Number(status) || 0;
  const text = typeof bodyText === "string" ? bodyText : toLowerText(bodyText);
  const lower = toLowerText(text);
  const parsed = bodyJson || tryParseJson(text);
  const env = extractUpstreamEnvelope(parsed, text);
  const retryAfterMs = headers ? headerRetryAfterMs(headers) : null;

  // 1) Kilo/upstream envelope wins: never report bare "kilo-gateway".
  if (env.hasEnvelope || env.providerName) {
    const up = (env.providerName || "").toLowerCase();
    const isConcurrency =
      lower.includes("request limited concurrency reached") ||
      lower.includes("concurrency") ||
      (env.current != null && env.limit != null && env.current >= env.limit);
    if (isConcurrency) {
      return {
        type: CLASSIFIED_TYPES.CONCURRENCY_LIMIT, scope: CLASSIFIED_SCOPES.PROVIDER,
        retryable: true, maxRetries: 1, retryAfterMs,
        upstreamProvider: env.providerName || null, limitSource: env.limitSource,
        remedyHint: env.remedyHint, isByok: env.isByok,
        current: env.current, limit: env.limit,
      };
    }
    const isOverload =
      lower.includes("server overload") || lower.includes("overloaded") ||
      lower.includes("temporarily rate-limited upstream") ||
      lower.includes("provider returned error");
    if (isOverload || up === "novita" || up === "stepfun" || env.limitSource === "upstream_provider_account") {
      const t = (lower.includes("server overload") || lower.includes("overloaded") || lower.includes("provider returned error"))
        ? CLASSIFIED_TYPES.UPSTREAM_OVERLOAD
        : CLASSIFIED_TYPES.UPSTREAM_RATE_LIMIT;
      return {
        type: t, scope: CLASSIFIED_SCOPES.PROVIDER,
        retryable: true, maxRetries: 1, retryAfterMs,
        upstreamProvider: env.providerName || null, limitSource: env.limitSource,
        remedyHint: env.remedyHint, isByok: env.isByok,
        current: env.current, limit: env.limit,
      };
    }
    // Envelope present but no overload wording → still upstream rate limit on 429.
    if (s === 429) {
      return {
        type: CLASSIFIED_TYPES.UPSTREAM_RATE_LIMIT, scope: CLASSIFIED_SCOPES.PROVIDER,
        retryable: true, maxRetries: 1, retryAfterMs,
        upstreamProvider: env.providerName || null, limitSource: env.limitSource,
        remedyHint: env.remedyHint, isByok: env.isByok,
        current: env.current, limit: env.limit,
      };
    }
  }

  // 2) Auth: invalid/disabled key. Single refresh elsewhere; here: no retry, long account lock.
  // Any bare 401 (or 403 without quota wording) is an auth failure even when
  // the message is unrecognized — never treat it as transient/invalid_request.
  if (s === 401 || s === 403) {
    const looksLikeQuota = lower.includes("quota") || lower.includes("daily limit") || lower.includes("top up") || lower.includes("rate limit");
    if (s === 401 && !looksLikeQuota) {
      return {
        type: CLASSIFIED_TYPES.INVALID_CREDENTIALS, scope: CLASSIFIED_SCOPES.ACCOUNT,
        retryable: false, maxRetries: 0, retryAfterMs: null,
        upstreamProvider: env.providerName || null, limitSource: env.limitSource,
        remedyHint: env.remedyHint, isByok: env.isByok, current: env.current, limit: env.limit,
      };
    }
    if (
      lower.includes("invalid or disabled api key") ||
      lower.includes("invalid api key") || lower.includes("invalid_api_key") ||
      lower.includes("incorrect api key") || lower.includes("invalid credentials") ||
      lower.includes("unauthorized") || lower.includes("invalid_grant") ||
      lower.includes("refresh_token_expired") || lower.includes("refresh_token_reused") ||
      lower.includes("refresh_token_invalidated") || lower === "" // bare 403 w/o quota wording
    ) {
      // 403 with explicit quota wording falls through to quota below.
      if (!(s === 403 && looksLikeQuota)) {
        return {
          type: CLASSIFIED_TYPES.INVALID_CREDENTIALS, scope: CLASSIFIED_SCOPES.ACCOUNT,
          retryable: false, maxRetries: 0, retryAfterMs: null,
          upstreamProvider: env.providerName || null, limitSource: env.limitSource,
          remedyHint: env.remedyHint, isByok: env.isByok, current: env.current, limit: env.limit,
        };
      }
    }
  }

  // 3) Daily/free quota: long model lock, no immediate retry.
  const quotaHit = DAILY_QUOTA_PATTERNS.some((p) => lower.includes(p));
  if (quotaHit || (s === 429 && lower.includes("free"))) {
    return {
      type: CLASSIFIED_TYPES.QUOTA_EXHAUSTED, scope: CLASSIFIED_SCOPES.MODEL,
      retryable: false, maxRetries: 0,
      retryAfterMs: retryAfterMs || null,
      upstreamProvider: env.providerName || null, limitSource: env.limitSource,
      remedyHint: env.remedyHint, isByok: env.isByok, current: env.current, limit: env.limit,
    };
  }

  // 4) Generic upstream wording without envelope.
  if (UPSTREAM_PATTERNS.some((p) => lower.includes(p)) || lower.includes("server overload") || lower.includes("temporarily rate-limited")) {
    const isConcurrency = lower.includes("concurrency") ||
      (env.current != null && env.limit != null && env.current >= env.limit);
    return {
      type: isConcurrency ? CLASSIFIED_TYPES.CONCURRENCY_LIMIT : CLASSIFIED_TYPES.UPSTREAM_OVERLOAD,
      scope: CLASSIFIED_SCOPES.PROVIDER,
      retryable: true, maxRetries: 1, retryAfterMs,
      upstreamProvider: env.providerName || null, limitSource: env.limitSource,
      remedyHint: env.remedyHint, isByok: env.isByok, current: env.current, limit: env.limit,
    };
  }

  // 5) Plain 429 → gateway rate limit (short backoff, not a long account lock).
  if (s === 429) {
    return {
      type: CLASSIFIED_TYPES.GATEWAY_RATE_LIMIT, scope: CLASSIFIED_SCOPES.GATEWAY,
      retryable: true, maxRetries: 1, retryAfterMs,
      upstreamProvider: env.providerName || null, limitSource: env.limitSource,
      remedyHint: env.remedyHint, isByok: env.isByok, current: env.current, limit: env.limit,
    };
  }

  // 6) Timeouts.
  if (s === 408 || s === 504 || lower.includes("etimedout") || lower.includes("timeout") || lower.includes("fetch connect timeout")) {
    return {
      type: CLASSIFIED_TYPES.TIMEOUT, scope: CLASSIFIED_SCOPES.PROVIDER,
      retryable: true, maxRetries: 1, retryAfterMs,
      upstreamProvider: env.providerName || null, limitSource: env.limitSource,
      remedyHint: env.remedyHint, isByok: env.isByok, current: env.current, limit: env.limit,
    };
  }

  // 7) 5xx → server error (transient, single retry at most).
  if (s >= 500) {
    return {
      type: CLASSIFIED_TYPES.SERVER_ERROR, scope: CLASSIFIED_SCOPES.PROVIDER,
      retryable: true, maxRetries: 1, retryAfterMs,
      upstreamProvider: env.providerName || null, limitSource: env.limitSource,
      remedyHint: env.remedyHint, isByok: env.isByok, current: env.current, limit: env.limit,
    };
  }

  // 8) Request-scoped 4xx (no credential signal) → do not lock, do not retry.
  if (s >= 400 && s < 500) {
    return {
      type: CLASSIFIED_TYPES.INVALID_REQUEST, scope: CLASSIFIED_SCOPES.MODEL,
      retryable: false, maxRetries: 0, retryAfterMs: null,
      upstreamProvider: env.providerName || null, limitSource: env.limitSource,
      remedyHint: env.remedyHint, isByok: env.isByok, current: env.current, limit: env.limit,
    };
  }

  return {
    type: CLASSIFIED_TYPES.UNKNOWN, scope: CLASSIFIED_SCOPES.PROVIDER,
    retryable: false, maxRetries: 0, retryAfterMs: null,
    upstreamProvider: env.providerName || null, limitSource: env.limitSource,
    remedyHint: env.remedyHint, isByok: env.isByok, current: env.current, limit: env.limit,
  };
}

// Backoff with jitter for temporary overload: 1–5s.
export function upstreamBackoffMs() {
  const span = UPSTREAM_BACKOFF_MAX_MS - UPSTREAM_BACKOFF_MIN_MS;
  return UPSTREAM_BACKOFF_MIN_MS + Math.floor(Math.random() * (span + 1));
}

export default classifyError;
