/**
 * SystemOne multi-provider routing helpers (pure, testable).
 *
 * v1 scope (approved): sequential fallback by list order only.
 * `combo.strategy` / `routing.strategy` / `routing.criteria` are accepted
 * and ignored (logged by the caller) so clients can send the full contract
 * without breaking. No parallel fan-out, no judge/consensus in v1.
 */

export const SYSTEMONE_AUTO_MODEL = "auto";
const MULTI_MODES = new Set(["combo", "auto"]);

/**
 * Strip gateway-only routing fields before forwarding upstream.
 * Upstream expects the native decision payload: model/state/questions
 * (+ any extra TypeSafe fields the client sent, e.g. `tools`).
 */
export function sanitizeSystemoneUpstreamBody(body, model) {
  const { model: _m, models: _ms, mode: _md, routing: _r, combo: _c, ...rest } = body || {};
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
  return [...free, ...configured].map((x) => x.candidate);
}
