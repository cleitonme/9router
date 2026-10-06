import { makeKv } from "../helpers/kvStore.js";

const kv = makeKv("modelHealth");

export function modelHealthKey({ connectionId, provider, model }) {
  const conn = connectionId || "unknown";
  const prov = provider || "unknown";
  const mod = model || "__all";
  return `${conn}|${prov}/${mod}`;
}

export async function getModelHealthEntry(key) {
  try {
    return await kv.get(key, null);
  } catch {
    return null;
  }
}

export async function setModelHealthEntry(key, value) {
  await kv.set(key, value);
  return value;
}

export async function getAllModelHealth() {
  try {
    return await kv.getAll();
  } catch {
    return {};
  }
}

export async function removeModelHealthEntry(key) {
  try {
    await kv.remove(key);
  } catch { /* fail-open */ }
}
