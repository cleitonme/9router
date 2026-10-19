// The gateway must react to upstream 403 "abusive traffic from this IP" by
// parking the egress proxy pool for 24h and immediately routing to another
// account/pool — instead of retrying the same banned network over and over.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Shared in-memory proxy-pool store backing BOTH mock modules, so every mock
// (auth.js paths and poolQuarantine.js paths) sees the same state.
const { poolsById, mockUpdateProviderConnection } = vi.hoisted(() => ({
  poolsById: new Map(),
  mockUpdateProviderConnection: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => []),
  getProviderConnectionById: vi.fn(async () => null),
  updateProviderConnection: mockUpdateProviderConnection,
  getSettings: vi.fn(async () => ({ fallbackStrategy: "fill-first" })),
  getProxyPools: vi.fn(async () => [...poolsById.values()]),
  validateApiKey: vi.fn(async () => false),
}));
vi.mock("@/models", () => ({
  getProxyPoolById: vi.fn(async (id) => poolsById.get(id) || null),
  getProxyPools: vi.fn(async () => [...poolsById.values()]),
  updateProxyPool: vi.fn(async (id, data) => {
    const cur = poolsById.get(id) || {};
    const merged = { ...cur, ...data };
    for (const k of Object.keys(data)) if (data[k] === null) merged[k] = null;
    poolsById.set(id, merged);
    return merged;
  }),
}));

import { classifyError, CLASSIFIED_TYPES } from "open-sse/utils/classifyError.js";
import { IP_ABUSIVE_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import {
  quarantineProxyPool,
  isPoolQuarantined,
  getQuarantinedPoolIds,
  resetPoolQuarantineCache,
} from "@/lib/network/poolQuarantine";
import { markAccountUnavailable, getProviderCredentials } from "@/sse/services/auth.js";
import { getProviderConnections, updateProviderConnection } from "@/lib/localDb";

const OPENCODE_ABUSIVE_403 =
  "[403]: OpenCode's free models aren't available from your current network because we've detected " +
  "abusive traffic from this IP address. This isn't related to your account. If you're on a VPN or " +
  "proxy, turn it off and try again, or subscribe to OpenCode Go at https://opencode.ai/go.";

describe("classifyError — upstream IP-abuse block", () => {
  it("classifies the OpenCode abusive-IP 403 as ip_abusive (account scope)", () => {
    const c = classifyError({ status: 403, bodyText: OPENCODE_ABUSIVE_403 });
    expect(c.type).toBe("ip_abusive");
    expect(c.type).toBe(CLASSIFIED_TYPES.IP_ABUSIVE);
    expect(c.scope).toBe("account");
    expect(c.retryable).toBe(false);
  });

  it("matches case-insensitively and on wording variants", () => {
    for (const text of [
      "Detected ABUSIVE TRAFFIC from this IP",
      "403 — these models are not available from your current network",
      "403 — these models aren't available from your current network",
    ]) {
      expect(classifyError({ status: 403, bodyText: text }).type).toBe("ip_abusive");
    }
  });

  it("never eats ordinary auth failures or model errors", () => {
    expect(classifyError({ status: 403, bodyText: "unauthorized" }).type).toBe("invalid_credentials");
    expect(classifyError({ status: 401, bodyText: "invalid api key" }).type).toBe("invalid_credentials");
    expect(classifyError({ status: 404, bodyText: "model not found" }).type).toBe("model_not_found");
  });
});

describe("pool quarantine lifecycle", () => {
  beforeEach(() => {
    poolsById.clear();
    resetPoolQuarantineCache();
  });

  afterEach(() => {
    vi.clearAllMocks();
    resetPoolQuarantineCache();
  });

  it("parks a banned pool for ~24h and reports it quarantined", async () => {
    poolsById.set("poolA", { id: "poolA", name: "A", proxyUrl: "http://ip:5628", isActive: true });
    const before = Date.now();
    const updated = await quarantineProxyPool("poolA", "upstream_ip_abuse", OPENCODE_ABUSIVE_403);
    const until = new Date(updated.quarantineUntil).getTime();
    expect(until - before).toBeGreaterThanOrEqual(IP_ABUSIVE_COOLDOWN_MS - 1000);
    expect(updated.testStatus).toBe("unavailable");
    expect(isPoolQuarantined({ quarantineUntil: updated.quarantineUntil })).toBe(true);
  });

  it("never shields non-quarantined or expired pools", () => {
    expect(isPoolQuarantined({ proxyUrl: "http://x", isActive: true })).toBe(false);
    expect(isPoolQuarantined({ quarantineUntil: new Date(Date.now() - 1000).toISOString() })).toBe(false);
    expect(isPoolQuarantined(null)).toBe(false);
  });

  it("repeated bans do not stack the quarantine unboundedly (≤2 windows)", async () => {
    poolsById.set("poolB", { id: "poolB", proxyUrl: "http://ip2:5628", isActive: true });
    await quarantineProxyPool("poolB");
    const firstUntil = new Date(poolsById.get("poolB").quarantineUntil).getTime();
    // A fresh hit much later may refresh, but only up to now + 2 windows
    // (an immediate re-hit keeps the same expiry — never an unbounded stack).
    const second = await quarantineProxyPool("poolB");
    expect(new Date(second.quarantineUntil).getTime()).toBeGreaterThanOrEqual(firstUntil - 2000);
    poolsById.set("poolB", { ...poolsById.get("poolB"), quarantineUntil: new Date(Date.now() - 5 * IP_ABUSIVE_COOLDOWN_MS).toISOString() });
    resetPoolQuarantineCache();
    const revived = await quarantineProxyPool("poolB");
    expect(new Date(revived.quarantineUntil).getTime() - Date.now()).toBeLessThanOrEqual(IP_ABUSIVE_COOLDOWN_MS * 2 + 1000);
  });

  it("clears quarantine when the pool test passes (update-carry path)", async () => {
    poolsById.set("poolC", { id: "poolC", proxyUrl: "http://ip3:5628", isActive: true });
    await quarantineProxyPool("poolC");
    expect(isPoolQuarantined(poolsById.get("poolC"))).toBe(true);
    poolsById.set("poolC", { ...poolsById.get("poolC"), quarantineUntil: null, quarantineReason: null, quarantineStartedAt: null });
    expect(isPoolQuarantined(poolsById.get("poolC"))).toBe(false);
  });

  it("getQuarantinedPoolIds lists parked pools and skips expired ones", async () => {
    poolsById.clear();
    poolsById.set("held", { id: "held", proxyUrl: "h", quarantineUntil: new Date(Date.now() + 60_000).toISOString() });
    poolsById.set("gone", { id: "gone", proxyUrl: "g", quarantineUntil: new Date(Date.now() - 60_000).toISOString() });
    resetPoolQuarantineCache();
    const ids = await getQuarantinedPoolIds();
    expect(ids.has("held")).toBe(true);
    expect(ids.has("gone")).toBe(false);
  });
});

describe("markAccountUnavailable — ip_abusive with no pool behind", () => {
  beforeEach(() => {
    updateProviderConnection.mockClear();
    getProviderConnections.mockResolvedValue([{ id: "conn1", provider: "opencode" }]);
  });

  it("locks the account for 24h at account level (modelLock___all)", async () => {
    const res = await markAccountUnavailable("conn1", 403, OPENCODE_ABUSIVE_403, "opencode", "jev-1.13-free");
    expect(res.shouldFallback).toBe(true);
    expect(res.cooldownMs).toBe(IP_ABUSIVE_COOLDOWN_MS);
    const update = updateProviderConnection.mock.calls[0]?.[1] || {};
    expect(Object.keys(update)).toContain("modelLock___all");
    expect(update.testStatus).toBe("unavailable");
    const lockUntil = new Date(update["modelLock___all"]).getTime();
    expect(lockUntil - Date.now()).toBeGreaterThanOrEqual(IP_ABUSIVE_COOLDOWN_MS - 1000);
  });
});

describe("getProviderCredentials — quarantine-aware routing", () => {
  const makeConn = (id, providerSpecificData = {}) => ({
    id, provider: "groq", isActive: true, providerSpecificData,
    displayName: id, name: id,
  });

  const quarantinedPool = () => ({ id: "poolA", name: "A", proxyUrl: "http://ip1:5628", isActive: true, quarantineUntil: new Date(Date.now() + IP_ABUSIVE_COOLDOWN_MS).toISOString() });
  const healthyPool = () => ({ id: "poolB", name: "B", proxyUrl: "http://ip2:5628", isActive: true });

  it("skips a connection whose explicit pool is parked, picks the healthy one", async () => {
    poolsById.clear();
    resetPoolQuarantineCache();
    poolsById.set("poolA", quarantinedPool());
    poolsById.set("poolB", healthyPool());
    getProviderConnections.mockResolvedValue([makeConn("c1", { proxyPoolId: "poolA" }), makeConn("c2", { proxyPoolId: "poolB" })]);
    const credits = await getProviderCredentials("groq");
    expect(credits.connectionId).toBe("c2");
  });

  it("reports allRateLimited (with the lift time) when only parked pools serve the provider", async () => {
    poolsById.clear();
    resetPoolQuarantineCache();
    poolsById.set("poolA", quarantinedPool());
    const { getSettings } = await import("@/lib/localDb");
    getSettings.mockResolvedValue({ fallbackStrategy: "fill-first", defaultProxyPoolId: "poolA" });
    getProviderConnections.mockResolvedValue([makeConn("c1")]);
    const credits = await getProviderCredentials("groq");
    expect(credits?.allRateLimited).toBe(true);
    expect(new Date(credits.retryAfter).getTime() - Date.now()).toBeGreaterThan(IP_ABUSIVE_COOLDOWN_MS - 60_000);
  });

  it("noAuth rotation never picks a quarantined pool", async () => {
    poolsById.clear();
    resetPoolQuarantineCache();
    poolsById.set("poolA", quarantinedPool());
    poolsById.set("poolB", healthyPool());
    const { getSettings } = await import("@/lib/localDb");
    getSettings.mockResolvedValue({
      fallbackStrategy: "fill-first",
      providerStrategies: { opencode: { rotateStrategy: "round-robin" } },
    });
    const credits = await getProviderCredentials("opencode");
    expect(credits.id).toBe("noauth");
    expect(credits.providerSpecificData.connectionProxyPoolId).toBe("poolB");
  });
});
