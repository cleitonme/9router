/**
 * SystemOne multi-provider routing helpers (pure, testable).
 *
 * v1 scope (approved): sequential fallback by list order only.
 * `combo.strategy` / `routing.strategy` / `routing.criteria` are accepted
 * and ignored (logged by the caller) so clients can send the full contract
 * without breaking. No parallel fan-out, no judge/consensus in v1.
 */

import {
  SYSTEMONE_AUTO_ORDER,
  SYSTEMONE_COOLDOWN_429_MS,
  SYSTEMONE_COOLDOWN_5XX_MS,
} from "../config/jev.js";

// Re-export so handler/tests share one source without importing config directly.
export { SYSTEMONE_COOLDOWN_429_MS, SYSTEMONE_COOLDOWN_5XX_MS };

export const SYSTEMONE_AUTO_MODEL = "auto";
const MULTI_MODES = new Set(["combo", "auto"]);

const SYSTEMONE_COOLDOWNABLE_5XX = new Set([502, 503, 504, 529]);

// Per-model auto cooldowns: candidate string -> epoch-ms expiry. RAM-only,
// per process (same scope as providerLock.js). Expired entries purge lazily.
const systemoneCooldowns = new Map();

function systemoneCooldownKey(candidate) {
  return String(candidate || "").toLowerCase();
}

/** Test/debug hook: clear one candidate cooldown, or all when omitted. */
export function resetSystemoneCooldowns(candidate) {
  if (candidate) systemoneCooldowns.delete(systemoneCooldownKey(candidate));
  else systemoneCooldowns.clear();
}

/** TTL in ms for a failure status. 429 → long, 502/503/504/529 → short, else 0 (no cooldown). */
export function systemoneCooldownTtlForStatus(status) {
  const s = Number(status);
  if (s === 429) return SYSTEMONE_COOLDOWN_429_MS;
  if (SYSTEMONE_COOLDOWNABLE_5XX.has(s)) return SYSTEMONE_COOLDOWN_5XX_MS;
  return 0;
}

/** Mark a candidate as cooling down. Returns expiry epoch-ms, or 0 when the status is not cooldownable. */
export function markSystemoneModelCooling(candidate, status, now = Date.now()) {
  const ttl = systemoneCooldownTtlForStatus(status);
  if (!candidate || !(ttl > 0)) return 0;
  const until = now + ttl;
  systemoneCooldowns.set(systemoneCooldownKey(candidate), { until, status: Number(status) });
  return until;
}

/** Remaining cooldown ms for a candidate, or 0 when not cooling. */
export function getSystemoneCooldownRemaining(candidate, now = Date.now()) {
  if (!candidate) return 0;
  const key = systemoneCooldownKey(candidate);
  const entry = systemoneCooldowns.get(key);
  if (!entry) return 0;
  if (entry.until <= now) {
    systemoneCooldowns.delete(key);
    return 0;
  }
  return entry.until - now;
}

/** True when the candidate is currently cooling down. */
export function isSystemoneModelCooling(candidate, now = Date.now()) {
  return getSystemoneCooldownRemaining(candidate, now) > 0;
}

/** Clear a candidate cooldown (call on success). */
export function clearSystemoneModelCooling(candidate) {
  if (!candidate) return;
  systemoneCooldowns.delete(systemoneCooldownKey(candidate));
}

/**
 * Filter cooling candidates out of an auto try-list.
 * Never returns [] from a non-empty input — when everything is cooling,
 * the full list is returned so the request still tries (fail-open).
 */
export function filterSystemoneCooling(candidates, now = Date.now()) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const fresh = candidates.filter((c) => !isSystemoneModelCooling(c, now));
  return fresh.length > 0 ? fresh : [...candidates];
}

/**
 * Strip gateway-only routing fields before forwarding upstream.
 * Upstream expects the native decision payload: model/state/questions
 * (+ any extra TypeSafe fields the client sent, e.g. `tools`).
 */
export function sanitizeSystemoneUpstreamBody(body, model) {
  const { model: _m, models: _ms, mode: _md, routing: _r, combo: _c, envelope: _e, ...rest } = body || {};
  return { ...rest, model };
}

/**
 * Resolve which models to try, in priority order.
 *
 * @param {object} body - request body
 * @param {function(string): (string[]|null|Promise<string[]|null>)} [comboLookup]
 *   sync or async lookup of a registered combo name -> models[].
 * @returns {Promise<{ mode: "single"|"combo"|"auto", models: string[] }>}
 * @throws {Error} with `code === "MISSING_MODELS"` when combo/auto has no list.
 */
export async function resolveSystemoneTargets(body, comboLookup = null) {
  const modeRaw = typeof body?.mode === "string" ? body.mode.toLowerCase() : null;
  const isAuto = body?.model === SYSTEMONE_AUTO_MODEL || modeRaw === "auto";
  const isCombo = modeRaw === "combo";

  if (!isAuto && !isCombo) {
    return { mode: "single", models: body?.model ? [body.model] : [] };
  }

  const mode = isAuto ? "auto" : "combo";
  let list = null;
  if (Array.isArray(body?.models) && body.models.length > 0) list = body.models;
  else if (Array.isArray(body?.routing?.models) && body.routing.models.length > 0) {
    list = body.routing.models;
  } else if (typeof body?.model === "string" && body.model !== SYSTEMONE_AUTO_MODEL && comboLookup) {
    // `model` holding a registered combo name (no `/`) — expand it.
    const expanded = await comboLookup(body.model);
    if (Array.isArray(expanded) && expanded.length > 0) list = expanded;
  }

  if (!Array.isArray(list) || list.length === 0) {
    const err = new Error(
      `Missing models for ${mode} mode: provide "models" (or "routing.models").`
    );
    err.code = "MISSING_MODELS";
    throw err;
  }
  return { mode, models: list.filter((m) => typeof m === "string" && m.length > 0) };
}

/**
 * Best-effort answer extraction from a native upstream decision payload.
 * The payload shape varies per lane (oc vs openrouter), so the envelope
 * always carries `data` intact and adds `answer` only when an obvious
 * string field exists.
 */
export function extractSystemoneAnswer(data) {
  if (!data || typeof data !== "object") return null;
  const candidates = [
    data.answer,
    data.output_text,
    data.text,
    data.result,
    data.decision,
    data.content,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }
  return null;
}

export function buildSystemoneSuccessEnvelope({
  data,
  selectedModel,
  provider,
  mode,
  fallbackUsed,
  attempted,
  usage,
}) {
  const envelope = {
    success: true,
    data: data ?? null,
    selected_model: selectedModel,
    provider,
    mode,
    fallback_used: !!fallbackUsed,
    attempted: Array.isArray(attempted) ? attempted : [],
    usage: usage
      ? {
          prompt_tokens: usage.prompt_tokens || 0,
          completion_tokens: usage.completion_tokens || 0,
          total_tokens:
            usage.total_tokens ??
            (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
        }
      : null,
  };
  const answer = extractSystemoneAnswer(data);
  if (answer !== null) envelope.answer = answer;
  return envelope;
}

export function buildSystemoneFailureEnvelope({ mode, attempted, errors }) {
  return {
    success: false,
    mode,
    attempted: Array.isArray(attempted) ? attempted : [],
    errors: Array.isArray(errors) ? errors : [],
    error: "All SystemOne models unavailable",
  };
}

/** Response helper: JSON envelope with CORS header (mirrors core style). */
export function systemoneEnvelopeResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Opt-in check for the routing envelope. Default is native upstream
 * passthrough (same shape as single-model), so swapping only the model
 * to `"auto"` never breaks existing clients.
 *
 * Enable with `"envelope": true` in the body or `?envelope=1`.
 */
export function shouldUseSystemoneEnvelope(body, searchParams) {
  if (body?.envelope === true) return true;
  try {
    const v =
      typeof searchParams?.get === "function" ? searchParams.get("envelope") : searchParams?.envelope;
    return v === "1" || v === "true";
  } catch {
    return false;
  }
}

export const SYSTEMONE_ROUTING_HEADER_NAMES = [
  "x-9router-selected-model",
  "x-9router-provider",
  "x-9router-mode",
  "x-9router-fallback-used",
  "x-9router-attempted",
];

/**
 * Routing metadata as response headers — carried on the native passthrough
 * response so the body stays byte-compatible with single-model clients.
 */
export function systemoneRoutingHeaders({ selectedModel, provider, mode, fallbackUsed, attempted }) {
  return {
    "x-9router-selected-model": selectedModel || "",
    "x-9router-provider": provider || "",
    "x-9router-mode": mode || "",
    "x-9router-fallback-used": fallbackUsed ? "true" : "false",
    "x-9router-attempted": (Array.isArray(attempted) ? attempted : []).join(","),
    "Access-Control-Expose-Headers": SYSTEMONE_ROUTING_HEADER_NAMES.join(", "),
  };
}

/**
 * Pick the default SystemOne model id for one provider entry.
 * Free variant first (lower cost), else the first `kind: "systemone"` id.
 *
 * @param {string[]} modelIds - registry model ids already filtered to systemone kind
 * @returns {string|null}
 */
export function pickSystemoneDefaultModel(modelIds) {
  if (!Array.isArray(modelIds) || modelIds.length === 0) return null;
  return modelIds.find((id) => typeof id === "string" && /free/i.test(id)) || modelIds[0];
}

/**
 * Zero-config discovery: build the auto try-list from registry entries.
 * Order: noAuth free lanes first (work without any setup), then configured
 * providers by registry priority. Providers without credentials, without a
 * systemone model, or currently blocked are skipped.
 *
 * Pure/testable: availability checks are injected.
 *
 * @param {object} deps
 * @param {Array} deps.entries - registry entries (need id/alias/priority/noAuth/models/systemoneConfig)
 * @param {function(string): (boolean|Promise<boolean>)} [deps.hasCredentials]
 * @param {function(string): boolean} [deps.isBlocked]
 * @returns {Promise<string[]>} candidate `"alias/model"` strings in try order
 */
export async function discoverSystemoneModels({ entries, hasCredentials, isBlocked }) {
  const free = [];
  const configured = [];
  for (const entry of entries || []) {
    if (!entry?.systemoneConfig) continue;
    const ids = (entry.models || [])
      .filter((m) => m?.kind === "systemone" && typeof m.id === "string")
      .map((m) => m.id);
    const def = pickSystemoneDefaultModel(ids);
    if (!def) continue;
    if (isBlocked?.(entry.id)) continue;
    const candidate = `${entry.alias || entry.id}/${def}`;
    const bucket = entry.noAuth ? free : configured;
    if (!entry.noAuth) {
      if (!(await hasCredentials?.(entry.id))) continue;
    }
    bucket.push({ candidate, priority: entry.priority ?? 999 });
  }
  free.sort((a, b) => a.priority - b.priority);
  configured.sort((a, b) => a.priority - b.priority);
  const merged = [...free, ...configured].map((x) => x.candidate);
  // Explicit SystemOne auto order (config/jev.js): rank known lanes first,
  // keep unknown future lanes in relative order at the end (fail-open).
  const rank = new Map(
    (Array.isArray(SYSTEMONE_AUTO_ORDER) ? SYSTEMONE_AUTO_ORDER : []).map((m, i) => [String(m).toLowerCase(), i])
  );
  return merged
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => {
      const ra = rank.has(a.candidate.toLowerCase()) ? rank.get(a.candidate.toLowerCase()) : Infinity;
      const rb = rank.has(b.candidate.toLowerCase()) ? rank.get(b.candidate.toLowerCase()) : Infinity;
      if (ra !== rb) return ra - rb;
      return a.index - b.index;
    })
    .map((x) => x.candidate);
}
