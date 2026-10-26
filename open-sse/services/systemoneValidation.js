import { PROVIDER_MEDIA } from "../providers/index.js";
import { buildSystemoneUrl } from "./systemoneRouting.js";

const PROBE_TIMEOUT_MS = 8000;
const DEFAULT_MODEL = "test";

export function isSystemoneOnlyProvider(provider) {
  const kinds = PROVIDER_MEDIA[provider]?.serviceKinds || ["llm"];
  return kinds.includes("systemone") && !kinds.includes("llm");
}

/**
 * Probe a System One-only provider (nace, v1m, typesafe) using its
 * systemoneConfig. Returns `null` when the provider is not System One-only,
 * otherwise `{ valid, error }`. Only 401/403 mean the key is invalid.
 */
export async function probeSystemoneProvider({
  provider,
  model,
  apiKey,
  providerSpecificData,
  fetchImpl,
} = {}) {
  const cfg = PROVIDER_MEDIA[provider]?.systemoneConfig;
  if (!cfg || !isSystemoneOnlyProvider(provider)) return null;
  if (cfg.authType === "none") return { valid: true, error: null };

  let url = buildSystemoneUrl(providerSpecificData?.baseUrl, cfg);
  if (!url) return null;

  if (url.includes("{accountId}")) {
    const accountId = providerSpecificData?.accountId;
    if (!accountId) return { valid: false, error: "Missing Account ID" };
    url = url.replace("{accountId}", accountId);
  }

  const resolvedModel = model || DEFAULT_MODEL;
  if (url.includes("{model}")) url = url.replace(/\{model\}/g, resolvedModel);

  const headers = { "Content-Type": "application/json", ...(cfg.headers || {}) };
  if (cfg.authHeader === "x-api-key") headers["x-api-key"] = apiKey;
  else headers.Authorization = `Bearer ${apiKey}`;

  const requestFetch = fetchImpl || globalThis.fetch;
  const res = await requestFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: resolvedModel,
      state: "ping",
      questions: { probe: { type: "noul", instructions: "Is this a connectivity test?" } },
    }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });

  if (res.status === 401 || res.status === 403) {
    return { valid: false, error: "Invalid API key" };
  }
  return { valid: true, error: null };
}
