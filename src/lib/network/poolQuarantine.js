import { getProxyPoolById, getProxyPools, updateProxyPool } from "@/models";
import { IP_ABUSIVE_COOLDOWN_MS } from "open-sse/config/errorConfig.js";

// Short-lived RAM cache so credential selection never hits SQLite per
// candidate. The write side updates the cache synchronously, so a pool
// quarantined on error is invisible to selection immediately.
const CACHE_TTL_MS = 30 * 1000;
let cache = { quarantined: new Map(), fetchedAt: 0 };

function cacheQuarantine(poolId, untilMs) {
  cache.quarantined.set(poolId, untilMs);
  cache.fetchedAt = Date.now();
}

/**
 * Park a proxy pool for a fixed window (default 24h) because the upstream
 * blocked its egress IP. Idempotent — repeated hits may only postpone the
 * expiry within the same window, never extend beyond it.
 */
export async function quarantineProxyPool(poolId, reason = "upstream_ip_abuse", errorText = null) {
  if (!poolId) return null;
  const now = Date.now();
  let currentUntil = 0;
  try {
    const pool = await getProxyPoolById(poolId);
    currentUntil = pool?.quarantineUntil ? new Date(pool.quarantineUntil).getTime() || 0 : 0;
  } catch { /* best-effort current state */ }
  const nextUntil = Math.max(now + IP_ABUSIVE_COOLDOWN_MS, Math.min(currentUntil, now + 2 * IP_ABUSIVE_COOLDOWN_MS));
  const quarantineUntil = new Date(nextUntil).toISOString();
  const trimmedError = typeof errorText === "string" ? errorText.slice(0, 300) : null;
  let updated = null;
  try {
    updated = await updateProxyPool(poolId, {
      quarantineUntil,
      quarantineReason: reason,
      quarantineStartedAt: new Date(now).toISOString(),
      testStatus: "unavailable",
      lastError: trimmedError || `IP blocked by upstream (${reason})`,
      lastErrorAt: new Date(now).toISOString(),
    });
  } catch (err) {
    console.error?.("[poolQuarantine] Failed to persist pool quarantine:", err?.message || err);
  }
  cacheQuarantine(poolId, nextUntil);
  return updated || { id: poolId, quarantineUntil, quarantineReason: reason };
}

/**
 * True when a pool object/row is currently quarantined (lazy expiry — no cron).
 */
export function isPoolQuarantined(pool, now = Date.now()) {
  const raw = pool?.quarantineUntil;
  if (!raw) return false;
  const until = new Date(raw).getTime();
  return Number.isFinite(until) && until > now;
}

/**
 * Set of pool IDs currently quarantined (fresh at most CACHE_TTL_MS).
 * Read-only cache — a quarantine written through quarantineProxyPool is
 * reflected immediately; direct DB edits surface within TTL.
 */
export async function getQuarantinedPoolIds() {
  const now = Date.now();
  if (cache.fetchedAt > 0 && now - cache.fetchedAt < CACHE_TTL_MS) {
    for (const [id, until] of cache.quarantined) {
      if (until <= now) cache.quarantined.delete(id);
    }
    return new Set(cache.quarantined.keys());
  }
  const fresh = new Map();
  try {
    const pools = await getProxyPools();
    for (const pool of pools) {
      if (isPoolQuarantined(pool, now)) fresh.set(pool.id, new Date(pool.quarantineUntil).getTime());
    }
  } catch (err) {
    console.error?.("[poolQuarantine] Failed to load quarantined pools:", err?.message || err);
  }
  cache = { quarantined: fresh, fetchedAt: now };
  return new Set(fresh.keys());
}

/** Invalidate the RAM cache (manual clear from dashboard, tests). */
export function resetPoolQuarantineCache() {
  cache = { quarantined: new Map(), fetchedAt: 0 };
}
