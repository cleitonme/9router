// Leitura do allowlist de modelos dev (model-catalog-raw.json).
//
// models.dev lista todos os modelos disponíveis por provedor, incluindo
// metadata como modalities (input/output) e status (deprecated, etc.).
// Para provedores com catálogos live autenticados (NVIDIA NIM), usamos esse
// allowlist como filtro: apenas modelos existentes em models.dev são incluídos,
// evitando modelos que retornam 404 da API (não existem ou foram removidos).
//
// O arquivo é escrito por src/lib/modelCatalog/sync.js (diariamente) e tem o
// formato slim: { nvidia: { "model-id": { i: ["image"], c: 262144, o: 262144 } } }
// onde "i" é apenas modaisidades não-texto; um modelo sem "i" é texto-only.

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

const CATALOG_RAW_FILE = path.join(DATA_DIR, "model-catalog-raw.json");

let cache = null;
let mtime = 0;

function load() {
  try {
    const stats = fs.statSync(CATALOG_RAW_FILE);
    if (stats.mtimeMs === mtime) return cache;
    const raw = fs.readFileSync(CATALOG_RAW_FILE, "utf8");
    const parsed = JSON.parse(raw);
    mtime = stats.mtimeMs;
    cache = parsed;
    return cache;
  } catch {
    return null;
  }
}

// Funções exportadas podem ser substituídas em testes.
let _getProviderModelAllowlist = (providerId) => {
  const catalog = load();
  if (!catalog?.[providerId]) return null;
  const modelIds = Object.keys(catalog[providerId]);
  if (modelIds.length === 0) return null;
  return new Set(modelIds);
};
let _supportsTextInput = (providerId, modelId) => {
  const catalog = load();
  const provider = catalog?.[providerId];
  if (!provider) return null;
  const model = provider[modelId];
  if (!model) return false;
  const inputModalities = model?.i || [];
  return inputModalities.length === 0;
};

export const getProviderModelAllowlist = _getProviderModelAllowlist;
export const supportsTextInput = _supportsTextInput;

// Para testes: substituir as implementações
export function __mockCatalogFunctions(mockAllowlist, mockTextInput) {
  if (mockAllowlist !== undefined) {
    _getProviderModelAllowlist = mockAllowlist;
  }
  if (mockTextInput !== undefined) {
    _supportsTextInput = mockTextInput;
  }
}

export function __resetCatalogMocks() {
  _getProviderModelAllowlist = (providerId) => {
    const catalog = load();
    if (!catalog?.[providerId]) return null;
    const modelIds = Object.keys(catalog[providerId]);
    if (modelIds.length === 0) return null;
    return new Set(modelIds);
  };
  _supportsTextInput = (providerId, modelId) => {
    const catalog = load();
    const provider = catalog?.[providerId];
    if (!provider) return null;
    const model = provider[modelId];
    if (!model) return false;
    const inputModalities = model?.i || [];
    return inputModalities.length === 0;
  };
}

export function isModelInAllowlist(providerId, modelId) {
  const allowlist = getProviderModelAllowlist(providerId);
  return allowlist ? allowlist.has(modelId) : null;
}

export function invalidateCatalogModelDevCache() {
  cache = null;
  mtime = 0;
}