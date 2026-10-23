/**
 * Session stickiness for smart-routed combos.
 *
 * Keeps the model chosen for a conversation stable across turns so upstream
 * prompt caches (Claude prompt cache, DeepSeek KV-cache, Gemini implicit cache)
 * stay warm. Policies:
 *   - smart   : keep the session model, switch only when the tier model changes
 *               with confidence >= threshold (adaptive hysteresis).
 *   - strict  : lock the first chosen model for the whole session (no extra
 *               classifier calls, 0 ms overhead on follow-ups).
 *   - per-turn: no stickiness; re-evaluate on every turn.
 *   - custom  : same as smart with a user-provided confidence threshold.
 *
 * Fail-open everywhere: a missing/stale entry simply returns null and the
 * caller keeps the combo's existing order.
 */

export const STICKY_SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
export const MAX_STICKY_SESSIONS = 5000;
export const DEFAULT_SWITCH_THRESHOLD = 0.8;

const stickyStore = new Map();

export function normalizeStickyPolicy(policy) {
  const value = (typeof policy === "string" ? policy : "").trim().toLowerCase();
  if (value === "strict" || value === "per-turn" || value === "custom" || value === "smart") {
    return value;
  }
  return "smart";
}

/** Accepts either a ratio (0.8) or a percentage (80); returns a 0..1 ratio. */
export function normalizeSwitchThreshold(threshold) {
  const value = Number(threshold);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_SWITCH_THRESHOLD;
  const ratio = value > 1 ? value / 100 : value;
  return Math.min(1, Math.max(0, ratio));
}

/**
 * Signature of the routing policy. Stored with each lock so changing the combo
 * policy invalidates models locked under the previous configuration.
 */
export function buildStickySignature(policy, threshold) {
  const normalized = normalizeStickyPolicy(policy);
  if (normalized === "smart" || normalized === "custom") {
    return `${normalized}:${normalizeSwitchThreshold(threshold)}`;
  }
  return normalized;
}

function stickyKey(comboName, sessionId) {
  return `${comboName}:${sessionId}`;
}

/**
 * Read a session lock. Drops stale/expired entries and entries whose model no
 * longer belongs to the combo.
 *
 * @returns {string|null} locked model, or null when there is no valid lock
 */
export function getStickyModel(comboName, sessionId, allowedModels, signature, now = Date.now()) {
  if (!comboName || !sessionId) return null;

  const key = stickyKey(comboName, sessionId);
  const entry = stickyStore.get(key);
  if (!entry) return null;

  if (now - entry.lastUsed > STICKY_SESSION_TTL_MS) {
    stickyStore.delete(key);
    return null;
  }

  if (signature && entry.signature !== signature) {
    stickyStore.delete(key);
    return null;
  }

  if (Array.isArray(allowedModels) && allowedModels.length > 0 && !allowedModels.includes(entry.model)) {
    stickyStore.delete(key);
    return null;
  }

  entry.lastUsed = now;
  return entry.model;
}

export function setStickyModel(comboName, sessionId, model, signature, now = Date.now()) {
  if (!comboName || !sessionId || !model) return;

  pruneStickySessions(now);
  stickyStore.set(stickyKey(comboName, sessionId), { model, lastUsed: now, signature });
}

/**
 * Clear one session lock, or every lock of a combo when sessionId is omitted.
 * With no comboName the whole store is cleared.
 */
export function clearStickySession(comboName, sessionId = null) {
  if (!comboName) {
    stickyStore.clear();
    return;
  }
  if (sessionId) {
    stickyStore.delete(stickyKey(comboName, sessionId));
    return;
  }
  const prefix = `${comboName}:`;
  for (const key of stickyStore.keys()) {
    if (key.startsWith(prefix)) stickyStore.delete(key);
  }
}

/** Bound memory: drop expired entries, then the oldest quarter when full. */
export function pruneStickySessions(now = Date.now()) {
  if (stickyStore.size < MAX_STICKY_SESSIONS) return;

  for (const [key, entry] of stickyStore.entries()) {
    if (now - entry.lastUsed > STICKY_SESSION_TTL_MS) stickyStore.delete(key);
  }

  if (stickyStore.size >= MAX_STICKY_SESSIONS) {
    const oldest = [...stickyStore.entries()]
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      .slice(0, Math.floor(MAX_STICKY_SESSIONS / 4));
    for (const [key] of oldest) stickyStore.delete(key);
  }
}

export function getStickySessionCount() {
  return stickyStore.size;
}

export function resetStickyStore() {
  stickyStore.clear();
}

/**
 * Decide the model order for one turn under a smart policy.
 *
 * `candidateModel` is the model the classifier picked (may live outside the
 * combo when a tier map points elsewhere). `allowedModels` extends membership
 * checks so tier-map targets can be locked too.
 *
 * Pure: no network, no clock. Returns the ordered models plus the lock to keep.
 *
 * @param {object} opts
 * @param {string[]} opts.models - combo models (fallback chain)
 * @param {string|null} [opts.candidateModel] - tier/classifier winner
 * @param {number|null} [opts.confidence] - classifier confidence (0..1)
 * @param {string} [opts.policy] - smart | strict | per-turn | custom
 * @param {number} [opts.threshold] - confidence required to switch (0..1 or %)
 * @param {string|null} [opts.stickyModel] - current session lock
 * @param {string[]} [opts.allowedModels] - lock membership (defaults to models)
 * @returns {{ models: string[], stickyModel: string|null, switched: boolean, reason: string }}
 */
export function resolveStickyRouting({
  models,
  candidateModel = null,
  confidence = null,
  policy = "smart",
  threshold = DEFAULT_SWITCH_THRESHOLD,
  stickyModel = null,
  allowedModels = null,
}) {
  const list = Array.isArray(models) ? [...models] : [];
  const membership = Array.isArray(allowedModels) && allowedModels.length > 0 ? allowedModels : list;
  const normalized = normalizeStickyPolicy(policy);
  const validCandidate = typeof candidateModel === "string" && candidateModel.trim()
    ? candidateModel.trim()
    : null;
  const validSticky = stickyModel && membership.includes(stickyModel) ? stickyModel : null;

  const moveToFront = (model) => [model, ...list.filter((m) => m !== model)];

  if (normalized === "per-turn") {
    return {
      models: validCandidate ? moveToFront(validCandidate) : list,
      stickyModel: null,
      switched: false,
      reason: "per-turn",
    };
  }

  if (validSticky) {
    if (normalized === "strict") {
      return {
        models: moveToFront(validSticky),
        stickyModel: validSticky,
        switched: false,
        reason: "strict-lock",
      };
    }

    const changed = Boolean(validCandidate && validCandidate !== validSticky);
    const confident = typeof confidence === "number"
      && Number.isFinite(confidence)
      && confidence >= normalizeSwitchThreshold(threshold);
    if (changed && confident) {
      return {
        models: moveToFront(validCandidate),
        stickyModel: validCandidate,
        switched: true,
        reason: "switch",
      };
    }
    return {
      models: moveToFront(validSticky),
      stickyModel: validSticky,
      switched: false,
      reason: "keep",
    };
  }

  if (validCandidate) {
    return {
      models: moveToFront(validCandidate),
      stickyModel: validCandidate,
      switched: false,
      reason: "initial",
    };
  }

  return { models: list, stickyModel: null, switched: false, reason: "no-candidate" };
}
