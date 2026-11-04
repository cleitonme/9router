// Model-health state machine (see docs/MODEL_HEALTH.md).
// Explicit states — "disabled" only ever means excluded from routing, never deleted.
export const MODEL_HEALTH_STATUS = {
  ACTIVE: "active",
  COOLDOWN: "cooldown",
  UNAVAILABLE_PROVIDER: "unavailable_provider",
  UNVERIFIED: "unverified",
  CONFIG_ERROR: "config_error",
};

export const MODEL_HEALTH_SCOPE = {
  ACCOUNT: "account",
  MODEL: "model",
  PROVIDER: "provider",
  GATEWAY: "gateway",
};

// Number of consecutive failures before auto-removing from combo
export const MODEL_FAILURE_THRESHOLD = 3;

// Retry interval after model is auto-removed (30 minutes)
export const MODEL_AUTO_RETRY_MS = 30 * 60 * 1000;

// Re-verification intervals (ms). Permanent errors are rechecked rarely,
// transient errors respect short cooldowns. All configurable via dashboard
// settings (settings.modelHealth) — values here are conservative defaults.
export const MODEL_HEALTH_DEFAULTS = {
  enabled: false,
  mode: "observe",
  checkIntervalMs: 60 * 60 * 1000,
  testTimeoutMs: 10 * 1000,
  testMaxTokens: 16,
  concurrencyPerProvider: 2,
  retryTransientMs: 5 * 60 * 1000,
  retryAccountMs: 30 * 60 * 1000,
  retryPermanentMs: 7 * 24 * 60 * 60 * 1000,
  historyLimit: 10,
};

export function nextRetryFor(reason, now = Date.now(), consecutiveFailures = 0) {
  const d = MODEL_HEALTH_DEFAULTS;
  if (reason === "model_retired") return new Date(now + d.retryPermanentMs).toISOString();
  if (reason === "payment_required" || reason === "invalid_credentials") {
    return new Date(now + d.retryAccountMs).toISOString();
  }
  // Auto-remove model after threshold failures
  if (consecutiveFailures >= MODEL_FAILURE_THRESHOLD) {
    return new Date(now + MODEL_AUTO_RETRY_MS).toISOString();
  }
  return new Date(now + d.retryTransientMs).toISOString();
}
