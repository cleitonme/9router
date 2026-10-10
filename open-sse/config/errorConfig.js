// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
// NOTE: daily/free quota (quota_exhausted) intentionally bypasses this cap and
// uses Retry-After/X-RateLimit-Reset or QUOTA_EXHAUSTED_DEFAULT_MS (6h).
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Canonical fallback policy (single source of truth, see utils/classifyError.js)
export const ACCOUNT_INVALID_COOLDOWN_MS = 30 * 60 * 1000; // 401 invalid/disabled key → account lock
export const QUOTA_EXHAUSTED_DEFAULT_MS = 6 * 60 * 60 * 1000; // daily quota w/o reset header → 6h
export const UPSTREAM_BACKOFF_MIN_MS = 1000;
export const UPSTREAM_BACKOFF_MAX_MS = 5000;

// Account-scoped billing/access cooldown (402 paid-model, insufficient
// balance, free-plan exclusion). Locks ONLY the affected account, never the
// model globally — a free model must not look dead because one key lacks funds.
export const PAYMENT_REQUIRED_COOLDOWN_MS = 30 * 60 * 1000;
// Provider-scoped model retirement recheck (410 EOL). Permanent errors are
// re-verified rarely; transient errors use short cooldowns instead.
export const MODEL_RETIRED_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
// Model-not-found / route-incompatible: skip the candidate without parking
// healthy accounts behind a long lock.
export const MODEL_SKIP_COOLDOWN_MS = 60 * 1000;

// Substring signals (lowercased before match). Kept here — never hardcoded
// in classifyError.js / accountFallback.js (config-driven convention).
export const PAYMENT_REQUIRED_PATTERNS = [
  "paid model",
  "credits required",
  "payment required",
  "insufficient balance",
  "insufficient funds",
  "no resource package",
  "not included in",
  "not included in your",
  "free-use",
  "free use",
  "billing",
  "top up your balance",
  "top-up your balance",
  "add funds",
  "out of credits",
  "no credits",
  "quota has been exhausted",
];
export const MODEL_RETIRED_PATTERNS = [
  "end of life",
  "end-of-life",
  "decommissioned",
  "retired",
  "discontinued",
  "no longer supported",
  "no longer available",
  "has been removed",
  "model has been removed",
  "sunset",
  "deprecated and removed",
];
export const MODEL_NOT_FOUND_PATTERNS = [
  "model_not_found",
  "no such model",
  "model not found",
  "unknown model",
  "does not exist",
  "model does not exist",
  "not a valid model",
];
export const ACCOUNT_ACCESS_PATTERNS = [
  "not enabled for",
  "not entitled",
  "access denied for",
  "no access to this model",
  "not authorized for this model",
  "not have access",
];
export const ROUTE_INCOMPATIBLE_PATTERNS = [
  "unknown variant",
  "invalid variant",
  "unsupported format",
  "incompatible route",
  "route not supported",
  "format not supported",
  "unsupported route",
];

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  { provider: "codex", text: "model is not supported when using codex with a chatgpt account", cooldownMs: MAX_RATE_LIMIT_COOLDOWN_MS },
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  // Groq TPM / context-limit wording (underscore code + phrases). Checked
  // before the generic 4xx no-fallback rule so 413/TPM always falls through
  // to the next combo model instead of aborting with "failed (no fallback)".
  { text: "rate_limit_exceeded",      backoff: true },
  { text: "tokens per minute",        backoff: true },
  { text: "request too large",        backoff: true },
  { text: "too many tokens",          backoff: true },
  { text: "tpm",                      backoff: true },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "daily limit",              backoff: true },
  { text: "free model daily limit",   backoff: true },
  { text: "top up credits",           backoff: true },
  { text: "top-up credits",           backoff: true },
  { text: "free version",             backoff: true },
  { text: "usage_limit_reached",      backoff: true },
  { text: "server overload",          backoff: true },
  { text: "temporarily rate-limited upstream", backoff: true },
  { text: "request limited concurrency reached", backoff: true },
  { text: "provider returned error",  backoff: true },
  { text: "limit_source",             backoff: true },
  { text: "provider_name",            backoff: true },
  { text: "remedy_hint",              backoff: true },
  { text: "invalid or disabled api key", cooldownMs: ACCOUNT_INVALID_COOLDOWN_MS },
  { text: "invalid api key",          cooldownMs: ACCOUNT_INVALID_COOLDOWN_MS },
  { text: "insufficient credit",      backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  // 413 Payload Too Large (e.g. Groq context/TPM overflow) must fall back,
  // never abort the combo. 429 keeps exponential backoff.
  { status: 413, backoff: true },
  { status: 429, backoff: true },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
