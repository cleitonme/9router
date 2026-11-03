// Live provider catalogue (authenticated /v1/models snapshot).
//
// Some providers expose a models endpoint that only answers with a key. The
// public `modelsFetcher` path is browser-side and unauthenticated, so it cannot
// be used for them. This service fetches server-side with the connection's own
// key, caches the result in SQLite (kv scope `providerCatalog`) and keeps a
// `retired` overlay for ids known to be gone (410/EOL or absent upstream).
//
// Fail-open everywhere: a failed refresh always returns the previous snapshot
// (or an empty one) and never throws into routing.
import REGISTRY from "open-sse/providers/registry/index.js";
import {
  CATALOG_TTL_MS,
  CATALOG_FETCH_TIMEOUT_MS,
  CATALOG_BACKGROUND_REFRESH_MIN_MS,
  isLikelyNonChatModelId,
} from "open-sse/config/catalogConfig.js";
import { getProviderConnections } from "@/lib/db/index.js";
import {
  getProviderCatalogEntry,
  setProviderCatalogEntry,
} from "@/lib/db/repos/providerCatalogRepo.js";

const REGISTRY_BY_KEY = new Map();
for (const entry of REGISTRY) {
  REGISTRY_BY_KEY.set(entry.id, entry);
  if (entry.alias) REGISTRY_BY_KEY.set(entry.alias, entry);
  for (const alias of entry.aliases || []) REGISTRY_BY_KEY.set(alias, entry);
}

const backgroundRefreshedAt = new Map();

function getRegistryEntry(providerId) {
  if (!providerId) return null;
  return REGISTRY_BY_KEY.get(providerId) || null;
}

export function getProviderRegistryEntry(providerId) {
  return getRegistryEntry(providerId);
}

export function canonicalProviderId(providerId) {
  return getRegistryEntry(providerId)?.id || providerId || null;
}

export function getCatalogConfig(providerId) {
  return getRegistryEntry(providerId)?.catalog || null;
}

export function isCatalogProvider(providerId) {
  return !!getCatalogConfig(providerId);
}

// Curated registry models that are served through chat/completions.
export function getStaticChatModels(providerId) {
  const entry = getRegistryEntry(providerId);
  if (!entry || !Array.isArray(entry.models)) return [];
  return entry.models
    .filter((model) => !model.kind || model.kind === "llm")
    .filter((model) => model.id && !isLikelyNonChatModelId(model.id))
    .map((model) => ({ id: model.id, name: model.name || model.id }));
}

export function normalizeCatalogModels(data) {
  const raw = Array.isArray(data)
    ? data
    : (data?.data ?? data?.models ?? data?.results ?? []);
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const id = String(item?.id ?? item?.name ?? item?.model ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: String(item?.name || id) });
  }
  return out;
}

// Drop non-chat models. Ids present in the curated registry keep their explicit
// kind (embedding/stt/tts are never catalogued); unknown ids use the shared
// pattern heuristic, so a brand-new chat model still appears automatically.
export function filterChatModels(providerId, models) {
  const entry = getRegistryEntry(providerId);
  const staticKindById = new Map(
    (entry?.models || []).map((model) => [model.id, model.kind || "llm"]),
  );
  return (Array.isArray(models) ? models : []).filter((model) => {
    const staticKind = staticKindById.get(model.id);
    if (staticKind && staticKind !== "llm") return false;
    if (!staticKind && isLikelyNonChatModelId(model.id)) return false;
    return true;
  });
}

async function fetchCatalogForConnection(config, connection) {
  const token = connection?.apiKey || connection?.accessToken;
  if (!token) throw new Error("missing_api_key");

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (config.auth === "bearer") headers.Authorization = `Bearer ${token}`;
  else if (config.authHeader) headers[config.authHeader] = token;

  const res = await fetch(config.url, {
    method: "GET",
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return normalizeCatalogModels(await res.json());
}

function sameProvider(connection, providerId, canonicalId) {
  const connProvider = canonicalProviderId(connection?.provider);
  return connProvider === canonicalId || connection?.provider === providerId;
}

// Merge the previous retired overlay with the new live snapshot:
// - ids seen upstream become available again (removed from retired)
// - ids absent upstream stay/get marked retired (only when we got a non-empty
//   live list, so a truncated/failed response never mass-retires the catalogue)
function mergeRetired(providerId, previous, liveModels) {
  const retiredById = new Map(
    (Array.isArray(previous) ? previous : [])
      .filter((item) => item && item.id)
      .map((item) => [item.id, item]),
  );
  if (!Array.isArray(liveModels) || liveModels.length === 0) {
    return [...retiredById.values()];
  }
  const liveIds = new Set(liveModels.map((model) => model.id));
  for (const id of liveIds) retiredById.delete(id);
  const now = new Date().toISOString();
  for (const model of getStaticChatModels(providerId)) {
    if (!liveIds.has(model.id) && !retiredById.has(model.id)) {
      retiredById.set(model.id, { id: model.id, at: now, source: "catalog" });
    }
  }
  return [...retiredById.values()];
}

export async function getCachedCatalog(providerId) {
  const entry = getRegistryEntry(providerId);
  if (!entry?.catalog) return null;
  return await getProviderCatalogEntry(entry.id);
}

export async function getCatalogModelIds(providerId) {
  const entry = getRegistryEntry(providerId);
  if (!entry?.catalog) return null;
  const cached = await getProviderCatalogEntry(entry.id);
  if (!cached || !Array.isArray(cached.models) || cached.models.length === 0) return null;
  const retired = new Set((cached.retired || []).map((item) => item?.id).filter(Boolean));
  return new Set(cached.models.map((model) => model.id).filter((id) => !retired.has(id)));
}

export function isModelRetired(cached, modelId) {
  if (!cached || !modelId) return false;
  return (cached.retired || []).some((item) => item?.id === modelId);
}

export async function refreshProviderCatalog(providerId, { force = false, connectionId = null } = {}) {
  const entry = getRegistryEntry(providerId);
  const config = entry?.catalog;
  if (!entry || !config) {
    return { provider: providerId, models: [], retired: [], error: "not_catalog_provider" };
  }

  const cached = await getProviderCatalogEntry(entry.id);
  const fresh = cached?.fetchedAt
    && Date.now() - new Date(cached.fetchedAt).getTime() < CATALOG_TTL_MS;
  if (cached && fresh && !force) return cached;

  let connections = [];
  try {
    connections = await getProviderConnections();
  } catch {
    connections = [];
  }
  connections = connections
    .filter((connection) => connection?.isActive !== false && sameProvider(connection, providerId, entry.id))
    .sort((a, b) => {
      if (connectionId && a.id === connectionId) return -1;
      if (connectionId && b.id === connectionId) return 1;
      return (a.priority ?? 0) - (b.priority ?? 0);
    });

  let lastError = null;
  for (const connection of connections.slice(0, 3)) {
    try {
      const live = await fetchCatalogForConnection(config, connection);
      const models = filterChatModels(entry.id, live);
      if (models.length === 0) {
        lastError = "empty_catalog";
        continue;
      }
      const snapshot = {
        provider: entry.id,
        fetchedAt: new Date().toISOString(),
        connectionId: connection.id,
        models,
        retired: mergeRetired(entry.id, cached?.retired, models),
      };
      await setProviderCatalogEntry(entry.id, snapshot);
      return snapshot;
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 200);
    }
  }

  // Fail-open: keep the previous snapshot, surface the failure for the caller.
  return {
    ...(cached || { provider: entry.id, fetchedAt: null, models: [], retired: [] }),
    error: lastError || (connections.length === 0 ? "no_active_connection" : "fetch_failed"),
  };
}

export async function markModelRetired(providerId, modelId) {
  const entry = getRegistryEntry(providerId);
  const model = String(modelId || "").trim();
  if (!entry?.catalog || !model) return false;
  try {
    const cached = (await getProviderCatalogEntry(entry.id)) || {
      provider: entry.id, fetchedAt: null, models: [], retired: [],
    };
    const retired = Array.isArray(cached.retired) ? [...cached.retired] : [];
    if (!retired.some((item) => item?.id === model)) {
      retired.push({ id: model, at: new Date().toISOString(), source: "upstream_410" });
    }
    await setProviderCatalogEntry(entry.id, { ...cached, retired });
    return true;
  } catch {
    return false;
  }
}

// Fire-and-forget refresh used by /v1/models when the cache is missing/stale.
// Throttled in-process so a burst of model-list calls cannot hammer upstream.
export function maybeRefreshCatalogInBackground(providerId) {
  const entry = getRegistryEntry(providerId);
  if (!entry?.catalog) return;
  const now = Date.now();
  const last = backgroundRefreshedAt.get(entry.id) || 0;
  if (now - last < CATALOG_BACKGROUND_REFRESH_MIN_MS) return;
  backgroundRefreshedAt.set(entry.id, now);
  refreshProviderCatalog(entry.id, { force: true }).catch(() => {});
}
