// Persistent per-account/per-model health (kv scope "modelHealth").
// Fail-open everywhere: kv failures must never break routing.
import { MODEL_HEALTH_STATUS, MODEL_HEALTH_DEFAULTS, nextRetryFor } from "open-sse/config/modelHealthConfig.js";
import {
  modelHealthKey,
  getModelHealthEntry,
  setModelHealthEntry,
  getAllModelHealth,
  removeModelHealthEntry,
} from "@/lib/db/repos/modelHealthRepo.js";

function sanitizeText(v, max = 300) {
  if (v == null) return null;
  const s = typeof v === "string" ? v : String(v);
  return s.slice(0, max);
}

function pushHistory(entry, item) {
  const limit = MODEL_HEALTH_DEFAULTS.historyLimit || 10;
  const history = Array.isArray(entry.history) ? entry.history : [];
  history.push(item);
  return history.slice(-limit);
}

/**
 * Record a probe/routing result. Never throws.
 * @returns the persisted entry (or a transient in-memory one on DB failure)
 */
export async function recordModelHealth({
  connectionId, provider, model,
  ok, statusCode = null, reason = null, scope = "model",
  latencyMs = null, errorText = null,
} = {}) {
  const now = new Date().toISOString();
  const key = modelHealthKey({ connectionId, provider, model });
  let prev = null;
  try {
    prev = await getModelHealthEntry(key);
  } catch { prev = null; }

  const consecutiveFailures = ok ? 0 : (prev?.consecutiveFailures || 0) + 1;
  let status;
  if (ok) {
    status = MODEL_HEALTH_STATUS.ACTIVE;
  } else if (reason === "model_retired") {
    status = MODEL_HEALTH_STATUS.UNAVAILABLE_PROVIDER;
  } else if (reason === "config_error") {
    status = MODEL_HEALTH_STATUS.CONFIG_ERROR;
  } else if (reason === "unverified") {
    status = MODEL_HEALTH_STATUS.UNVERIFIED;
  } else {
    status = MODEL_HEALTH_STATUS.COOLDOWN;
  }

  const entry = {
    status,
    reason: sanitizeText(reason) || (ok ? "ok" : "unknown"),
    scope,
    statusCode,
    provider: provider || prev?.provider || null,
    connectionId: connectionId || prev?.connectionId || null,
    model: model || prev?.model || null,
    lastCheck: now,
    nextRetry: ok ? null : nextRetryFor(reason, Date.now()),
    consecutiveFailures,
    latencyMs: latencyMs ?? prev?.latencyMs ?? null,
    lastError: ok ? null : sanitizeText(errorText),
    updatedAt: now,
    history: pushHistory(prev || {}, {
      ts: now, ok: !!ok, code: statusCode,
      reason: sanitizeText(reason, 120),
    }),
  };

  try {
    await setModelHealthEntry(key, entry);
  } catch { /* fail-open */ }
  return entry;
}

export async function getModelHealth({ connectionId, provider, model } = {}) {
  try {
    return await getModelHealthEntry(modelHealthKey({ connectionId, provider, model }));
  } catch {
    return null;
  }
}

/**
 * Eligibility for routing. In observe mode everything stays eligible;
 * in enforce mode, cooldown/unavailable entries before nextRetry are skipped.
 * Never throws; defaults to eligible.
 */
export async function isModelEligible({ connectionId, provider, model, mode = "observe" } = {}) {
  try {
    if (mode !== "enforce") return { eligible: true, reason: null };
    const entry = await getModelHealth({ connectionId, provider, model });
    if (!entry) return { eligible: true, reason: null };
    if (entry.status === MODEL_HEALTH_STATUS.ACTIVE) return { eligible: true, reason: null };
    if (entry.status === MODEL_HEALTH_STATUS.UNVERIFIED) return { eligible: true, reason: "unverified" };
    if (entry.nextRetry && new Date(entry.nextRetry).getTime() <= Date.now()) {
      return { eligible: true, reason: "retry_due" };
    }
    if (entry.status === MODEL_HEALTH_STATUS.COOLDOWN || entry.status === MODEL_HEALTH_STATUS.UNAVAILABLE_PROVIDER || entry.status === MODEL_HEALTH_STATUS.CONFIG_ERROR) {
      return { eligible: false, reason: entry.reason, nextRetry: entry.nextRetry };
    }
    return { eligible: true, reason: null };
  } catch {
    return { eligible: true, reason: null };
  }
}

export async function listModelHealth() {
  try {
    return await getAllModelHealth();
  } catch {
    return {};
  }
}

export async function clearModelHealth({ connectionId, provider, model } = {}) {
  try {
    await removeModelHealthEntry(modelHealthKey({ connectionId, provider, model }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Filter managed-combo candidates by durable health.
 * A candidate is skipped ONLY on a model/provider-scoped blocking state
 * still before nextRetry (retired, not-found, incompatible route) — an
 * account-scoped entry (payment, invalid key, quota of ONE account) never
 * removes the model from the other healthy accounts. Unknown entries (never
 * tested) stay eligible. Fail-open: returns the original list.
 * @returns {{ models: string[], skipped: Array<{model, reason, nextRetry}> }}
 */
export async function filterComboCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { models: candidates || [], skipped: [] };
  }
  let all;
  try {
    all = await listModelHealth();
  } catch {
    return { models: candidates, skipped: [] };
  }
  const now = Date.now();
  // Blocking entries keyed by provider/model — model/provider scope only.
  const blocking = new Map();
  for (const entry of Object.values(all)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.status !== MODEL_HEALTH_STATUS.COOLDOWN && entry.status !== MODEL_HEALTH_STATUS.UNAVAILABLE_PROVIDER) continue;
    if (entry.scope !== "model" && entry.scope !== "provider") continue;
    if (entry.nextRetry && new Date(entry.nextRetry).getTime() <= now) continue;
    if (!entry.provider || !entry.model || entry.model === "__all") continue;
    const k = `${String(entry.provider).toLowerCase()}|${String(entry.model).toLowerCase()}`;
    if (!blocking.has(k)) blocking.set(k, entry);
  }
  if (blocking.size === 0) return { models: candidates, skipped: [] };

  const kept = [];
  const skipped = [];
  for (const m of candidates) {
    const s = typeof m === "string" ? m.indexOf("/") : -1;
    const k = s > 0 ? `${m.slice(0, s).toLowerCase()}|${m.slice(s + 1).toLowerCase()}` : null;
    const hit = k ? blocking.get(k) : null;
    if (hit) skipped.push({ model: m, reason: hit.reason || null, nextRetry: hit.nextRetry || null });
    else kept.push(m);
  }
  // Never strand a combo: if everything is blocked, keep the original order
  // and let live fallback decide (locks expire, health re-tests).
  if (kept.length === 0) return { models: candidates, skipped };
  return { models: kept, skipped };
}
