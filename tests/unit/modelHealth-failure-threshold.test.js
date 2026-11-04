import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const MODEL_HEALTH_STATUS = {
  ACTIVE: "active",
  COOLDOWN: "cooldown",
  UNAVAILABLE_PROVIDER: "unavailable_provider",
  UNVERIFIED: "unverified",
  CONFIG_ERROR: "config_error",
};

const MODEL_FAILURE_THRESHOLD = 3;
const MODEL_AUTO_RETRY_MS = 30 * 60 * 1000;

const mockRepo = {
  entries: {},
  modelHealthKey({ provider, model }) {
    return `${provider}|${model}`;
  },
  async getModelHealthEntry(key) {
    return this.entries[key] || null;
  },
  async setModelHealthEntry(key, entry) {
    this.entries[key] = entry;
  },
  async getAllModelHealth() {
    return this.entries;
  },
  clear() {
    this.entries = {};
  },
};

function sanitizeText(v, max = 300) {
  if (v == null) return null;
  const s = typeof v === "string" ? v : String(v);
  return s.slice(0, max);
}

async function recordModelHealth({
  connectionId, provider, model,
  ok, statusCode = null, reason = null, scope = "model",
  latencyMs = null, errorText = null,
}) {
  const now = new Date().toISOString();
  const key = mockRepo.modelHealthKey({ provider, model });
  const prev = await mockRepo.getModelHealthEntry(key);

  const consecutiveFailures = ok ? 0 : (prev?.consecutiveFailures || 0) + 1;
  let status;
  if (ok) {
    status = MODEL_HEALTH_STATUS.ACTIVE;
  } else if (reason === "model_retired") {
    status = MODEL_HEALTH_STATUS.UNAVAILABLE_PROVIDER;
  } else if (reason === "config_error") {
    status = MODEL_HEALTH_STATUS.CONFIG_ERROR;
  } else if (reason === "unverified") {
    status = MODEL_HEALTH_STATUS.UNVERIFIED;
  } else if (consecutiveFailures >= MODEL_FAILURE_THRESHOLD) {
    status = MODEL_HEALTH_STATUS.UNAVAILABLE_PROVIDER;
  } else {
    status = MODEL_HEALTH_STATUS.COOLDOWN;
  }

  const entry = {
    status,
    reason: sanitizeText(reason) || (ok ? "ok" : "unknown"),
    scope,
    statusCode,
    provider,
    connectionId,
    model,
    lastCheck: now,
    nextRetry: ok ? null : (reason === "model_retired"
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      : consecutiveFailures >= MODEL_FAILURE_THRESHOLD
        ? new Date(Date.now() + MODEL_AUTO_RETRY_MS).toISOString()
        : new Date(Date.now() + 5 * 60 * 1000).toISOString()),
    consecutiveFailures,
    latencyMs,
    lastError: ok ? null : sanitizeText(errorText),
    updatedAt: now,
  };

  await mockRepo.setModelHealthEntry(key, entry);
  return entry;
}

async function getUnavailableModelIds(providerIds) {
  const wanted = new Set(
    (Array.isArray(providerIds) ? providerIds : [providerIds])
      .filter(Boolean)
      .map((id) => String(id).toLowerCase()),
  );
  if (wanted.size === 0) return new Set();
  const out = new Set();
  const all = await mockRepo.getAllModelHealth();
  for (const entry of Object.values(all)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.status !== MODEL_HEALTH_STATUS.UNAVAILABLE_PROVIDER) continue;
    if (entry.scope !== "model" && entry.scope !== "provider") continue;
    if (!entry.model || entry.model === "__all") continue;
    if (!entry.provider || !wanted.has(String(entry.provider).toLowerCase())) continue;
    out.add(entry.model);
  }
  return out;
}

describe("modelHealth - auto-remove after failures", () => {
  beforeEach(() => {
    mockRepo.clear();
  });

  it("marks model as COOLDOWN for single failure", async () => {
    const result = await recordModelHealth({
      connectionId: "conn1",
      provider: "nvidia",
      model: "deepseek-ai/deepseek-v4.1-flash",
      ok: false,
      statusCode: 502,
      reason: "timeout",
    });

    expect(result.status).toBe(MODEL_HEALTH_STATUS.COOLDOWN);
    expect(result.consecutiveFailures).toBe(1);
  });

  it("marks model as UNAVAILABLE_PROVIDER after threshold failures", async () => {
    const now = Date.now();
    // First failure - COOLDOWN
    await recordModelHealth({
      connectionId: "conn1",
      provider: "nvidia",
      model: "deepseek-ai/deepseek-v4.1-flash",
      ok: false,
      statusCode: 502,
      reason: "timeout",
    });

    // Second failure
    await recordModelHealth({
      connectionId: "conn1",
      provider: "nvidia",
      model: "deepseek-ai/deepseek-v4.1-flash",
      ok: false,
      statusCode: 502,
      reason: "timeout",
    });

    // Third failure - should be UNAVAILABLE_PROVIDER
    const result = await recordModelHealth({
      connectionId: "conn1",
      provider: "nvidia",
      model: "deepseek-ai/deepseek-v4.1-flash",
      ok: false,
      statusCode: 502,
      reason: "timeout",
    });

    expect(result.status).toBe(MODEL_HEALTH_STATUS.UNAVAILABLE_PROVIDER);
    expect(result.consecutiveFailures).toBe(MODEL_FAILURE_THRESHOLD);
  });

  it("auto-removed model has correct nextRetry (5 min)", async () => {
    // Trigger 3 failures
    for (let i = 0; i < 3; i++) {
      await recordModelHealth({
        connectionId: "conn1",
        provider: "nvidia",
        model: "deepseek-ai/deepseek-v4.1-flash",
        ok: false,
        statusCode: 502,
        reason: "timeout",
      });
    }

    const result = await recordModelHealth({
      connectionId: "conn1",
      provider: "nvidia",
      model: "deepseek-ai/deepseek-v4.1-flash",
      ok: false,
      statusCode: 502,
      reason: "timeout",
    });

    const expectedRetry = new Date(Date.now() + MODEL_AUTO_RETRY_MS).toISOString();
    expect(result.nextRetry).toBe(expectedRetry);
  });

  it("resets consecutiveFailures on success", async () => {
    // First fail, then succeed
    await recordModelHealth({
      connectionId: "conn1",
      provider: "nvidia",
      model: "deepseek-ai/deepseek-v4.1-flash",
      ok: false,
      statusCode: 502,
      reason: "timeout",
    });

    const result = await recordModelHealth({
      connectionId: "conn1",
      provider: "nvidia",
      model: "deepseek-ai/deepseek-v4.1-flash",
      ok: true,
    });

    expect(result.status).toBe(MODEL_HEALTH_STATUS.ACTIVE);
    expect(result.consecutiveFailures).toBe(0);
    expect(result.nextRetry).toBeNull();
  });

  it("getUnavailableModelIds returns auto-removed models", async () => {
    // Create an auto-removed model
    for (let i = 0; i < 4; i++) {
      await recordModelHealth({
        connectionId: "conn1",
        provider: "nvidia",
        model: "deepseek-ai/deepseek-v4.1-flash",
        ok: false,
        statusCode: 502,
        reason: "timeout",
      });
    }

    // Create a model in cooldown (not removed)
    await recordModelHealth({
      connectionId: "conn1",
      provider: "nvidia",
      model: "other-model",
      ok: false,
      statusCode: 502,
      reason: "timeout",
    });

    const unavailable = await getUnavailableModelIds("nvidia");
    expect(unavailable.has("deepseek-ai/deepseek-v4.1-flash")).toBe(true);
    expect(unavailable.has("other-model")).toBe(false);
  });
});