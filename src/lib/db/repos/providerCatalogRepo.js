import { makeKv } from "../helpers/kvStore.js";

const kv = makeKv("providerCatalog");

// Per-provider live catalogue snapshot:
// { provider, fetchedAt, connectionId, models: [{id,name}], retired: [{id,at}] }
export async function getProviderCatalogEntry(providerId) {
  try {
    return await kv.get(providerId, null);
  } catch {
    return null;
  }
}

export async function setProviderCatalogEntry(providerId, value) {
  await kv.set(providerId, value);
  return value;
}

export async function getAllProviderCatalogs() {
  try {
    return await kv.getAll();
  } catch {
    return {};
  }
}

export async function removeProviderCatalogEntry(providerId) {
  try {
    await kv.remove(providerId);
  } catch { /* fail-open */ }
}
