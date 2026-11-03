// Leitura do allowlist de modelos dev (model-catalog-raw.json).
//
// models.dev lista todos os modelos disponíveis por provedor, incluindo
// metadata como modalities (input/output) e status (deprecated, etc.).
// Para provedores com catálogos live autenticados (NVIDIA NIM), usamos esse
// allowlist como filtro: apenas modelos existentes em models.dev são incluídos,
// evitando modelos que retornam 404 da API (não existem ou foram removidos).
//
// O arquivo é escrito por src/lib/modelCatalog/sync.js (diariamente) e tem o
// formato slim: { nvidia: { "model-id": { i: ["image"], t: true, c: 262144 } } }
// onde "i" são apenas modalidades não-texto e "t" indica suporte a entrada de
// texto. Arquivos anteriores à v3 não têm "t"; nesse caso "i" vazio continua
// significando texto-only.

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

function textInputFor(model) {
  if (!model) return null;
  // v3+: explicit flag. Legacy files: no non-text modality means text-only.
  if (typeof model.t === "boolean") return model.t;
  return (model.i || []).length === 0;
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
  // Unknown model in models.dev is "unknown", not "non-text": free-endpoint
  // detection may surface models models.dev has not catalogued yet.
  return textInputFor(provider[modelId]);
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
    return textInputFor(provider[modelId]);
  };
}

export function isModelInAllowlist(providerId, modelId) {
  const allowlist = getProviderModelAllowlist(providerId);
  return allowlist ? allowlist.has(modelId) : null;
}

// Exposto para testes da regra de modalidade (não use no runtime).
export function __textInputForModel(model) {
  return textInputFor(model);
}

export function invalidateCatalogModelDevCache() {
  cache = null;
  mtime = 0;
}