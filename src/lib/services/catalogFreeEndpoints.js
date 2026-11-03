// Detecção de modelos "Free Endpoint" do build.nvidia.com.
//
// O /v1/models da NVIDIA é público e lista modelos antigos/pagos sem indicar
// gratuidade. O build.nvidia.com marca cada endpoint que funciona na API
// gratuita com o selo "Free Endpoint" (filtro nimType=nim_type_preview), então
// essa página é a fonte do conjunto realmente disponível no free tier.
//
// A página é HTML/RSC (não há API pública sem auth), por isso o resultado é
// cacheado em disco e atualizado no máximo uma vez por dia. Fail-open: qualquer
// erro mantém o cache anterior (ou null, que faz o chamador cair para a
// allowlist do models.dev).

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";
import {
  FREE_ENDPOINT_TTL_MS,
  FREE_ENDPOINT_FETCH_TIMEOUT_MS,
  FREE_ENDPOINT_MAX_PAGES,
  normalizeModelKey,
} from "open-sse/config/catalogConfig.js";

const CACHE_FILE = path.join(DATA_DIR, "free-endpoints.json");

let cache = null;
let mtime = 0;

function load() {
  try {
    const stats = fs.statSync(CACHE_FILE);
    if (stats.mtimeMs === mtime) return cache;
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    mtime = stats.mtimeMs;
    cache = parsed;
    return cache;
  } catch {
    return null;
  }
}

function writeAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, contents, "utf8");
  fs.renameSync(`${file}.tmp`, file);
}

// Cada card do build.nvidia.com é um bloco HTML próprio; os que exibem o badge
// "Free Endpoint" têm o link /publisher/slug do modelo. O regex exige exatamente
// um "/" para não capturar links de publisher (/deepseek-ai) nem assets.
const MODEL_HREF_RE = /href="\/([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)"/i;

export function parseFreeEndpointHrefs(html) {
  const out = [];
  const seen = new Set();
  for (const card of String(html || "").split("nv-card-content")) {
    if (!card.includes("Free Endpoint")) continue;
    const match = card.match(MODEL_HREF_RE);
    const href = match?.[1];
    if (!href || seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

function parsePageTotal(html) {
  const match = String(html || "").match(/resultPageTotal\\?":(\d+)/);
  const total = Number.parseInt(match?.[1] || "1", 10);
  return Number.isFinite(total) && total > 0 ? total : 1;
}

async function fetchPage(url, filter, page) {
  const params = new URLSearchParams({ page: String(page) });
  if (filter) params.set("filters", filter);
  const res = await fetch(`${url}?${params.toString()}`, {
    headers: { accept: "text/html" },
    cache: "no-store",
    signal: AbortSignal.timeout(FREE_ENDPOINT_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchFreeEndpointModels(config) {
  if (!config?.url) return [];
  const first = await fetchPage(config.url, config.filter, 1);
  const pageTotal = Math.min(parsePageTotal(first), FREE_ENDPOINT_MAX_PAGES);

  const hrefs = new Set(parseFreeEndpointHrefs(first));
  for (let page = 2; page <= pageTotal; page += 1) {
    const html = await fetchPage(config.url, config.filter, page);
    for (const href of parseFreeEndpointHrefs(html)) hrefs.add(href);
  }

  return [...hrefs].map((id) => ({ id, key: normalizeModelKey(id) }));
}

function toKeySet(models) {
  const keys = (Array.isArray(models) ? models : [])
    .map((model) => model?.key || normalizeModelKey(model?.id))
    .filter(Boolean);
  return keys.length ? new Set(keys) : null;
}

function defaultGetFreeEndpointKeys(providerId) {
  const entry = load()?.[providerId];
  return toKeySet(entry?.models);
}

let _getFreeEndpointKeysSync = defaultGetFreeEndpointKeys;

export const getFreeEndpointKeysSync = (providerId) => _getFreeEndpointKeysSync(providerId);

/**
 * Refresh the on-disk cache for a provider when stale. Returns the current key
 * set (fresh or stale) or null when nothing is available. Never throws.
 */
export async function refreshFreeEndpointCache(providerId, config) {
  if (!providerId || !config?.url) return getFreeEndpointKeysSync(providerId);
  const cached = load()?.[providerId];
  const age = cached?.fetchedAt ? Date.now() - Date.parse(cached.fetchedAt) : Infinity;
  if (cached && age < FREE_ENDPOINT_TTL_MS) {
    return toKeySet(cached.models);
  }

  try {
    const models = await fetchFreeEndpointModels(config);
    if (models.length === 0) return toKeySet(cached?.models);
    const next = {
      ...(load() || {}),
      [providerId]: { fetchedAt: new Date().toISOString(), models },
    };
    writeAtomic(CACHE_FILE, JSON.stringify(next));
    cache = next;
    mtime = 0;
    return toKeySet(models);
  } catch {
    return toKeySet(cached?.models);
  }
}

export function invalidateFreeEndpointCache() {
  cache = null;
  mtime = 0;
}

// Para testes: injeta um set fixo de chaves.
export function __mockFreeEndpointKeys(fn) {
  _getFreeEndpointKeysSync = fn;
}

export function __resetFreeEndpointMocks() {
  _getFreeEndpointKeysSync = defaultGetFreeEndpointKeys;
}
