// Auto-managed combos backed by a provider's live catalogue.
//
// config = {
//   type: "provider-catalog",
//   provider: "nvidia",
//   refreshSchedule: "daily",
//   freeOnly: true,
//   limit: null,
//   excludeKeywords: [],
// }
//
// The scheduler rebuilds `models` from the live catalogue: new ids are added,
// retired/410'd ids are dropped. `kind` is forced to "managed" so the request
// path also skips candidates that are blocked in durable model health.
import {
  CATALOG_REFRESH_SCHEDULES,
  CATALOG_VALIDATE_CONCURRENCY,
  CATALOG_VALIDATE_MAX_MODELS,
  isLikelyNonChatModelId,
} from "open-sse/config/catalogConfig.js";
import { fetchComboLatencies } from "open-sse/services/combo.js";
import { getDisabledByProvider } from "@/lib/db/repos/disabledModelsRepo.js";
import { filterComboCandidates, recordModelHealth } from "@/lib/modelHealth/service.js";
import {
  canonicalProviderId,
  getProviderRegistryEntry,
  getStaticChatModels,
  isCatalogProvider,
  refreshProviderCatalog,
} from "./providerCatalog.js";

export function validateProviderCatalogConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("Provider catalog configuration is required");
  }
  const provider = String(config.provider || "").trim();
  if (!provider) throw new Error("Provider is required");
  if (!isCatalogProvider(provider)) {
    throw new Error(`Provider ${provider} has no live catalogue`);
  }

  const refreshSchedule = config.refreshSchedule || "daily";
  if (!CATALOG_REFRESH_SCHEDULES.includes(refreshSchedule)) {
    throw new Error("Invalid refresh schedule");
  }

  const limit = config.limit == null || config.limit === ""
    ? null
    : Number(config.limit);
  if (limit != null && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
    throw new Error("Model limit must be a whole number between 1 and 50");
  }

  const excludeKeywords = (Array.isArray(config.excludeKeywords) ? config.excludeKeywords : [])
    .map((keyword) => (typeof keyword === "string" ? keyword.trim() : ""))
    .filter(Boolean)
    .slice(0, 20);

  const entry = getProviderRegistryEntry(provider);
  const providerIsFree =
    entry?.hasFree === true || entry?.category === "free" || entry?.category === "freeTier";
  if (config.freeOnly === true && !providerIsFree) {
    throw new Error(`Provider ${provider} has no free-tier catalogue`);
  }
  const freeOnly = typeof config.freeOnly === "boolean" ? config.freeOnly : providerIsFree;
  const validateModels = typeof config.validateModels === "boolean" ? config.validateModels : true;

  return {
    type: "provider-catalog",
    provider: canonicalProviderId(provider),
    refreshSchedule,
    freeOnly,
    limit,
    excludeKeywords,
    validateModels,
  };
}

function matchesExclusions(model, exclusions) {
  if (exclusions.length === 0) return false;
  const haystack = `${model.id} ${model.name || ""}`.toLowerCase();
  return exclusions.some((keyword) => haystack.includes(keyword));
}

// Order candidates fastest-first using measured latency. Models without a
// measurement go after measured ones; the curated seed order is the tiebreak so
// the list stays stable between refreshes. Probe failures go last.
function orderCatalogModels(providerId, alias, models, { latencyMap = null, failed = null } = {}) {
  const staticOrder = new Map(
    getStaticChatModels(providerId).map((model, index) => [model.id, index]),
  );
  const latencyOf = (model) => latencyMap?.get(`${alias}/${model.id}`) ?? Infinity;
  const failedOf = (model) => (failed?.has(`${alias}/${model.id}`) ? 1 : 0);

  return [...models].sort((a, b) => {
    const fa = failedOf(a);
    const fb = failedOf(b);
    if (fa !== fb) return fa - fb;

    const la = latencyOf(a);
    const lb = latencyOf(b);
    if (la !== lb) return la - lb;

    const ai = staticOrder.has(a.id) ? staticOrder.get(a.id) : Number.MAX_SAFE_INTEGER;
    const bi = staticOrder.has(b.id) ? staticOrder.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return String(a.id).localeCompare(String(b.id));
  });
}

// Probe models that have no measured latency yet. Bounded per refresh: only the
// first `CATALOG_VALIDATE_MAX_MODELS` unknowns, at most
// `CATALOG_VALIDATE_CONCURRENCY` at a time. Results feed durable model health so
// unreachable ids fall out after repeated refreshes and the next one skips them.
async function validateCatalogModels(candidates) {
  const failed = new Set();
  const latencyMap = new Map();
  if (!Array.isArray(candidates) || candidates.length === 0) return { failed, latencyMap };

  const queue = candidates.slice(0, CATALOG_VALIDATE_MAX_MODELS);
  const { pingModelByKind } = await import("@/app/api/models/test/ping.js");
  let cursor = 0;

  const workers = Array.from(
    { length: Math.min(CATALOG_VALIDATE_CONCURRENCY, queue.length) },
    async () => {
      while (cursor < queue.length) {
        const candidate = queue[cursor++];
        let result;
        try {
          result = await pingModelByKind(candidate, "llm");
        } catch (error) {
          result = { ok: false, status: 0, latencyMs: null, error: String(error?.message || error) };
        }

        const slash = candidate.indexOf("/");
        const provider = slash > 0 ? candidate.slice(0, slash) : null;
        const model = slash > 0 ? candidate.slice(slash + 1) : candidate;
        const timedOut = /timeout|timed out|etimedout/i.test(String(result?.error || ""));
        try {
          await recordModelHealth({
            connectionId: "catalog-validation",
            provider, model,
            ok: result?.ok === true,
            statusCode: result?.status || 0,
            reason: result?.ok === true ? "ok" : (timedOut ? "timeout" : "probe_failed"),
            scope: "model",
            latencyMs: typeof result?.latencyMs === "number" ? result.latencyMs : null,
            errorText: result?.ok === true ? null : (result?.error || null),
          });
        } catch { /* fail-open */ }

        if (result?.ok === true) {
          if (typeof result.latencyMs === "number") latencyMap.set(candidate, result.latencyMs);
        } else {
          failed.add(candidate);
        }
      }
    },
  );
  await Promise.all(workers);
  return { failed, latencyMap };
}

/**
 * Build the combo model list from the live catalogue.
 * Fail-open: a failed refresh falls back to the cached snapshot, then to the
 * curated static seed. Never returns a cleared list because upstream hiccuped.
 */
export async function buildProviderCatalogComboModels(config, { force = true, connectionId = null } = {}) {
  const validated = validateProviderCatalogConfig(config);
  const entry = getProviderRegistryEntry(validated.provider);
  const alias = entry?.alias || entry?.id || validated.provider;

  let snapshot = null;
  let warning = null;
  try {
    snapshot = await refreshProviderCatalog(validated.provider, { force, connectionId });
    if (snapshot?.error) warning = snapshot.error;
  } catch (error) {
    warning = String(error?.message || error);
  }

  let models = Array.isArray(snapshot?.models) ? snapshot.models : [];
  const fromLiveCatalog = models.length > 0;
  if (models.length === 0) {
    models = getStaticChatModels(validated.provider);
    warning = warning || "catalog_unavailable_using_seed";
  }

  const retired = new Set(
    (snapshot?.retired || []).map((item) => item?.id).filter(Boolean),
  );

  let disabled = new Set();
  try {
    const [byAlias, byId] = await Promise.all([
      getDisabledByProvider(alias),
      getDisabledByProvider(validated.provider),
    ]);
    disabled = new Set([...(byAlias || []), ...(byId || [])]);
  } catch { /* fail-open */ }

  let filtered = models
    .filter((model) => model?.id)
    .filter((model) => !retired.has(model.id))
    .filter((model) => !disabled.has(model.id))
    .filter((model) => !isLikelyNonChatModelId(model.id))
    .filter((model) => !matchesExclusions(model, validated.excludeKeywords));

  const candidateOf = (model) => `${alias}/${model.id}`;

  // Load measured latency for every candidate, then probe only ids that have no
  // measurement yet (bounded). This is what keeps NVIDIA's advertised-but-dead
  // ids out and puts the fastest live model first.
  let latencyMap = new Map();
  let failedCandidates = new Set();
  try {
    const measured = await fetchComboLatencies(filtered.map(candidateOf));
    if (measured instanceof Map) latencyMap = measured;
  } catch { /* fail-open: latency sort is optional */ }

  if (validated.validateModels && fromLiveCatalog) {
    const unknown = filtered
      .map(candidateOf)
      .filter((candidate) => !latencyMap.has(candidate));
    if (unknown.length > 0) {
      try {
        const probed = await validateCatalogModels(unknown);
        for (const [candidate, ms] of probed.latencyMap) latencyMap.set(candidate, ms);
        failedCandidates = probed.failed;
      } catch { /* fail-open: keep unvalidated list */ }
    }
  }

  // Drop models that just failed a probe, unless nothing survived (never strand
  // the combo on an upstream-wide outage).
  let droppedFailed = false;
  if (failedCandidates.size > 0) {
    const usable = filtered.filter((model) => !failedCandidates.has(candidateOf(model)));
    if (usable.length > 0) {
      filtered = usable;
      droppedFailed = true;
    } else {
      warning = warning || "catalog_validation_all_failed";
    }
  }

  filtered = orderCatalogModels(validated.provider, alias, filtered, {
    latencyMap,
    failed: failedCandidates,
  });

  const limited = validated.limit ? filtered.slice(0, validated.limit) : filtered;
  const candidates = limited.map(candidateOf);

  // Drop candidates blocked in durable health (410/EOL, not-found, route
  // incompatible). Account-scoped locks never remove a model here.
  let kept = candidates;
  let skipped = [];
  try {
    const result = await filterComboCandidates(candidates);
    kept = result.models;
    skipped = result.skipped;
  } catch { /* fail-open: keep full list */ }

  if (droppedFailed) {
    const already = new Set(skipped.map((item) => item.model));
    for (const candidate of failedCandidates) {
      if (!already.has(candidate)) {
        skipped.push({ model: candidate, reason: "catalog_validation_failed", nextRetry: null });
      }
    }
  }

  const byCandidate = new Map(limited.map((model) => [`${alias}/${model.id}`, model]));
  const staticIds = new Set(getStaticChatModels(validated.provider).map((model) => model.id));
  const details = kept.map((candidate) => {
    const model = byCandidate.get(candidate);
    return {
      model: candidate,
      providerModelId: model?.id || candidate.slice(alias.length + 1),
      name: model?.name || model?.id || candidate,
      isNew: model ? !staticIds.has(model.id) : false,
    };
  });

  return {
    provider: validated.provider,
    models: kept,
    details,
    skipped,
    fetchedAt: snapshot?.fetchedAt || null,
    warning,
  };
}
