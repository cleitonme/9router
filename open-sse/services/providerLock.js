/**
 * RAM-only locks for provider/upstream/gateway scopes.
 * Short-lived overload signals must not persist long account locks in DB.
 * Keyed case-insensitively; expired entries are purged lazily on read.
 */

const locks = new Map();

function norm(s) {
  return String(s || "").toLowerCase();
}

function keyFor(kind, name, model) {
  if (kind === "upstream") return `upstream:${norm(name)}:${model ? norm(model) : "*"}`;
  if (kind === "gateway") return `gateway:${norm(name)}`;
  return `provider:${norm(name)}`;
}

function setLock(key, ttlMs, reason) {
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 60 * 1000;
  locks.set(key, { until: Date.now() + ttl, reason: String(reason || "").slice(0, 200) });
}

function getLock(key) {
  const entry = locks.get(key);
  if (!entry) return null;
  if (entry.until <= Date.now()) {
    locks.delete(key);
    return null;
  }
  return entry;
}

/** Block a real upstream (e.g. Novita/StepFun) optionally scoped to a model. */
export function blockUpstream(upstream, model = null, ttlMs = 60 * 1000, reason = "upstream_overload") {
  if (!upstream) return;
  setLock(keyFor("upstream", upstream, model), ttlMs, reason);
  // Also set the wildcard so other models sharing the same congested
  // upstream skip without burning an upstream call.
  if (model) setLock(keyFor("upstream", upstream, null), Math.min(ttlMs, 30 * 1000), reason);
}

/** True when this upstream (model-scoped or wildcard) is in cooldown. */
export function isUpstreamBlocked(upstream, model = null) {
  if (!upstream) return null;
  return getLock(keyFor("upstream", upstream, model)) || getLock(keyFor("upstream", upstream, null));
}

/** Block a logical provider (e.g. groq, kilo-gateway) — generalizes blockGroq. */
export function blockLogicalProvider(provider, ttlMs = 60 * 1000, reason = "") {
  if (!provider) return;
  setLock(keyFor("provider", provider), ttlMs, reason);
}

export function isLogicalProviderBlocked(provider) {
  if (!provider) return null;
  return getLock(keyFor("provider", provider));
}

/** Block a whole gateway (e.g. kilo-gateway unreachable). */
export function blockGateway(gateway, ttlMs = 60 * 1000, reason = "gateway_unavailable") {
  if (!gateway) return;
  setLock(keyFor("gateway", gateway), ttlMs, reason);
}

export function isGatewayBlocked(gateway) {
  if (!gateway) return null;
  return getLock(keyFor("gateway", gateway));
}

/** For tests/debug: current live locks. */
export function listLocks() {
  const now = Date.now();
  const out = [];
  for (const [key, v] of locks.entries()) {
    if (v.until <= now) {
      locks.delete(key);
      continue;
    }
    out.push({ key, ...v });
  }
  return out;
}

export function clearLocks() {
  locks.clear();
}
