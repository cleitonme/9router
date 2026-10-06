import { ERROR_RULES, BACKOFF_CONFIG, TRANSIENT_COOLDOWN_MS, ACCOUNT_INVALID_COOLDOWN_MS, QUOTA_EXHAUSTED_DEFAULT_MS, PAYMENT_REQUIRED_COOLDOWN_MS, MODEL_SKIP_COOLDOWN_MS } from "../config/errorConfig.js";
import { classifyError } from "../utils/classifyError.js";

/**
 * Calculate exponential backoff cooldown for rate limits (429)
 * Level 1: 1s, Level 2: 2s, Level 3: 4s... → max 4 min
 * @param {number} backoffLevel - Current backoff level
 * @returns {number} Cooldown in milliseconds
 */
export function getQuotaCooldown(backoffLevel = 0) {
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = BACKOFF_CONFIG.base * Math.pow(2, level);
  return Math.min(cooldown, BACKOFF_CONFIG.max);
}

/**
 * Check if error should trigger account fallback (switch to next account)
 * Config-driven: matches ERROR_RULES top-to-bottom (text rules first, then status)
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message text
 * @param {number} backoffLevel - Current backoff level for exponential backoff
 * @returns {{ shouldFallback: boolean, cooldownMs: number, newBackoffLevel?: number }}
 */
export function checkFallbackError(status, errorText, backoffLevel = 0, provider = null, extra = {}) {
  // Canonical classification first: auth/quota/upstream get precise
  // cooldowns + scopes. Falls back to legacy ERROR_RULES for anything
  // the classifier marks unknown/invalid_request.
  try {
    const bodyJson = extra?.bodyJson ?? null;
    const headers = extra?.headers ?? null;
    const text = typeof errorText === "string" ? errorText : (errorText ? JSON.stringify(errorText) : "");
    const c = classifyError({ status, bodyText: text, bodyJson, headers });
    if (c && c.type && c.type !== "unknown") {
      if (c.type === "invalid_credentials") {
        return { shouldFallback: true, cooldownMs: ACCOUNT_INVALID_COOLDOWN_MS, classification: c };
      }
      if (c.type === "payment_required") {
        // Billing / plan / balance failure: account-scoped only. The model
        // stays eligible on every other healthy account.
        const precise = extra?.retryAfterMs && extra.retryAfterMs > Date.now()
          ? extra.retryAfterMs - Date.now()
          : (c.retryAfterMs && c.retryAfterMs > Date.now() ? c.retryAfterMs - Date.now() : PAYMENT_REQUIRED_COOLDOWN_MS);
        return { shouldFallback: true, cooldownMs: precise, classification: c };
      }
      if (c.type === "model_retired" || c.type === "model_not_found" || c.type === "route_incompatible") {
        // Skip the candidate (next account/model in the combo) without
        // parking healthy accounts behind a long lock. The durable
        // unavailable_provider state lives in kv modelHealth (recorded by the
        // caller), not in modelLock_*.
        return { shouldFallback: true, cooldownMs: MODEL_SKIP_COOLDOWN_MS, classification: c };
      }
      if (c.type === "quota_exhausted") {
        const precise = extra?.retryAfterMs && extra.retryAfterMs > Date.now()
          ? extra.retryAfterMs - Date.now()
          : (c.retryAfterMs && c.retryAfterMs > Date.now() ? c.retryAfterMs - Date.now() : QUOTA_EXHAUSTED_DEFAULT_MS);
        return { shouldFallback: true, cooldownMs: precise, classification: c };
      }
      if (c.type === "upstream_overload" || c.type === "upstream_rate_limit" || c.type === "concurrency_limit" || c.type === "gateway_rate_limit" || c.type === "timeout" || c.type === "server_error") {
        // Short DB cooldown only; the RAM providerLock carries the real grouping.
        // Honor Retry-After when present but cap it so overload never parks an account for hours.
        const raMs = extra?.retryAfterMs && extra.retryAfterMs > Date.now()
          ? extra.retryAfterMs - Date.now()
          : (c.retryAfterMs && c.retryAfterMs > Date.now() ? c.retryAfterMs - Date.now() : TRANSIENT_COOLDOWN_MS);
        const capped = Math.min(raMs, TRANSIENT_COOLDOWN_MS);
        return { shouldFallback: true, cooldownMs: Math.max(capped, 1000), classification: c };
      }
      // invalid_request/unknown fall through to legacy ERROR_RULES below:
      // bare 402/404 and other account-scoped statuses must still fall back
      // (next account/model). Only request-scoped 400s with no quota wording
      // end up no-fallback.
    }
  } catch { /* fall through to legacy rules */ }

  const lowerError = errorText
    ? (typeof errorText === "string" ? errorText : JSON.stringify(errorText)).toLowerCase()
    : "";

  for (const rule of ERROR_RULES) {
    if (rule.provider && rule.provider !== provider) continue;
    // Text-based rule: match substring in error message
    if (rule.text && lowerError && lowerError.includes(rule.text)) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }

    // Status-based rule: match HTTP status code
    if (rule.status && rule.status === status) {
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: getQuotaCooldown(newLevel), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }
  }

  // Request-scoped client errors that matched no rule above: a 400 caused by the
  // request itself (context overflow, malformed body, unsupported parameter) says
  // nothing about the credential, so cooling the account down only removes a
  // healthy connection from rotation. With a single connection it is worse: every
  // later request in the window fails with a copy of this very error
  // ("all 1 accounts locked for <model> | lastError=[400]: ..."), which hides the
  // real cause from the caller and makes unrelated sessions look like they hit the
  // same limit. Hand the upstream error back for this request instead.
  // Account-scoped statuses keep their rules above (401/402/403/404/429), and the
  // text rules still win for rate-limit / quota / capacity wording.
  if (status >= 400 && status < 500 && status !== 401 && status !== 402 && status !== 403 && status !== 429) {
    return { shouldFallback: false, cooldownMs: 0 };
  }

  // Default: transient cooldown for any unmatched error
  return { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS };
}

/**
 * Check if account is currently unavailable (cooldown not expired)
 */
export function isAccountUnavailable(unavailableUntil) {
  if (!unavailableUntil) return false;
  return new Date(unavailableUntil).getTime() > Date.now();
}

/**
 * Calculate unavailable until timestamp
 */
export function getUnavailableUntil(cooldownMs) {
  return new Date(Date.now() + cooldownMs).toISOString();
}

/**
 * Get the earliest rateLimitedUntil from a list of accounts
 * @param {Array} accounts - Array of account objects with rateLimitedUntil
 * @returns {string|null} Earliest rateLimitedUntil ISO string, or null
 */
export function getEarliestRateLimitedUntil(accounts) {
  let earliest = null;
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.rateLimitedUntil) continue;
    const until = new Date(acc.rateLimitedUntil).getTime();
    if (until <= now) continue;
    if (!earliest || until < earliest) earliest = until;
  }
  if (!earliest) return null;
  return new Date(earliest).toISOString();
}

/**
 * Format rateLimitedUntil to human-readable "reset after Xm Ys"
 * @param {string} rateLimitedUntil - ISO timestamp
 * @returns {string} e.g. "reset after 2m 30s"
 */
export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}

/** Prefix for model lock flat fields on connection record */
export const MODEL_LOCK_PREFIX = "modelLock_";

/** Special key used when no model is known (account-level lock) */
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

/** Build the flat field key for a model lock */
export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

/**
 * Check if a model lock on a connection is still active.
 * Reads flat field `modelLock_${model}` (or `modelLock___all` when model=null).
 */
export function isModelLockActive(connection, model) {
  const key = getModelLockKey(model);
  const expiry = connection[key] || connection[MODEL_LOCK_ALL];
  if (!expiry) return false;
  return new Date(expiry).getTime() > Date.now();
}

/**
 * Get earliest active model lock expiry across all modelLock_* fields.
 * Used for UI cooldown display.
 */
export function getEarliestModelLockUntil(connection) {
  if (!connection) return null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Build update object to set a model lock on a connection.
 */
export function buildModelLockUpdate(model, cooldownMs) {
  const key = getModelLockKey(model);
  return { [key]: new Date(Date.now() + cooldownMs).toISOString() };
}

/**
 * Build update object to clear all model locks on a connection.
 */
export function buildClearModelLocksUpdate(connection) {
  const cleared = {};
  for (const key of Object.keys(connection)) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

/**
 * Filter available accounts (not in cooldown)
 */
export function filterAvailableAccounts(accounts, excludeId = null) {
  const now = Date.now();
  return accounts.filter(acc => {
    if (excludeId && acc.id === excludeId) return false;
    if (acc.rateLimitedUntil) {
      const until = new Date(acc.rateLimitedUntil).getTime();
      if (until > now) return false;
    }
    return true;
  });
}

/**
 * Reset account state when request succeeds
 * Clears cooldown and resets backoff level to 0
 * @param {object} account - Account object
 * @returns {object} Updated account with reset state
 */
export function resetAccountState(account) {
  if (!account) return account;
  return {
    ...account,
    rateLimitedUntil: null,
    backoffLevel: 0,
    lastError: null,
    status: "active"
  };
}

/**
 * Apply error state to account
 * @param {object} account - Account object
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message
 * @returns {object} Updated account with error state
 */
export function applyErrorState(account, status, errorText) {
  if (!account) return account;

  const backoffLevel = account.backoffLevel || 0;
  const { cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel);

  return {
    ...account,
    rateLimitedUntil: cooldownMs > 0 ? getUnavailableUntil(cooldownMs) : null,
    backoffLevel: newBackoffLevel ?? backoffLevel,
    lastError: { status, message: errorText, timestamp: new Date().toISOString() },
    status: "error"
  };
}
