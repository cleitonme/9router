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
  isLikelyNonChatModelId,
} from "open-sse/config/catalogConfig.js";
import { getDisabledByProvider } from "@/lib/db/repos/disabledModelsRepo.js";
import { filterComboCandidates } from "@/lib/modelHealth/service.js";
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

  return {
    type: "provider-catalog",
    provider: canonicalProviderId(provider),
    refreshSchedule,
    freeOnly,
    limit,
    excludeKeywords,
  };
}

function matchesExclusions(model, exclusions) {
  if (exclusions.length === 0) return false;
  const haystack = `${model.id} ${model.name || ""}`.toLowerCase();
  return exclusions.some((keyword) => haystack.includes(keyword));
}

function orderCatalogModels(providerId, models) {
  const staticOrder = new Map(
    getStaticChatModels(providerId).map((model, index) => [model.id, index]),
  );
  return [...models].sort((a, b) => {
    const ai = staticOrder.has(a.id) ? staticOrder.get(a.id) : Number.MAX_SAFE_INTEGER;
    const bi = staticOrder.has(b.id) ? staticOrder.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return String(a.id).localeCompare(String(b.id));
  });
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

  const filtered = orderCatalogModels(validated.provider, models)
    .filter((model) => model?.id)
    .filter((model) => !retired.has(model.id))
    .filter((model) => !disabled.has(model.id))
    .filter((model) => !isLikelyNonChatModelId(model.id))
    .filter((model) => !matchesExclusions(model, validated.excludeKeywords));

  const limited = validated.limit ? filtered.slice(0, validated.limit) : filtered;
  const candidates = limited.map((model) => `${alias}/${model.id}`);

  // Drop candidates blocked in durable health (410/EOL, not-found, route
  // incompatible). Account-scoped locks never remove a model here.
  let kept = candidates;
  let skipped = [];
  try {
    const result = await filterComboCandidates(candidates);
    kept = result.models;
    skipped = result.skipped;
  } catch { /* fail-open: keep full list */ }

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
