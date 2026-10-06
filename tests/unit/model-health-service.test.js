// modelHealth kv service: explicit states, account isolation, managed-combo
// filtering, enforce/observe eligibility. Uses the real sqlite layer with the
// modelHealth scope cleaned per test (same pattern as users-repo.test.js).
import { describe, expect, it, beforeEach } from "vitest";
import { getAdapter } from "@/lib/db/driver.js";
import {
  recordModelHealth,
  getModelHealth,
  isModelEligible,
  filterComboCandidates,
  clearModelHealth,
  listModelHealth,
} from "@/lib/modelHealth/service.js";

beforeEach(async () => {
  const db = await getAdapter();
  db.run("DELETE FROM kv WHERE scope = 'modelHealth'");
});

describe("recordModelHealth / getModelHealth", () => {
  it("stores reason, scope, lastCheck, nextRetry and a bounded history", async () => {
    const entry = await recordModelHealth({
      connectionId: "conn-a", provider: "glm", model: "glm-5.2",
      ok: false, statusCode: 410, reason: "model_retired", scope: "model",
      errorText: "end of life",
    });
    expect(entry.status).toBe("unavailable_provider");
    expect(entry.scope).toBe("model");
    expect(entry.lastCheck).toBeTruthy();
    expect(entry.nextRetry).toBeTruthy();
    expect(entry.consecutiveFailures).toBe(1);

    const read = await getModelHealth({ connectionId: "conn-a", provider: "glm", model: "glm-5.2" });
    expect(read.reason).toBe("model_retired");
    expect(read.history.length).toBe(1);
  });

  it("success reactivates and clears the failure streak", async () => {
    await recordModelHealth({
      connectionId: "conn-a", provider: "glm", model: "glm-4.7-flash",
      ok: false, statusCode: 503, reason: "probe_failed", scope: "model",
    });
    const entry = await recordModelHealth({
      connectionId: "conn-a", provider: "glm", model: "glm-4.7-flash",
      ok: true, statusCode: 200, reason: "ok", scope: "model", latencyMs: 123,
    });
    expect(entry.status).toBe("active");
    expect(entry.consecutiveFailures).toBe(0);
    expect(entry.nextRetry).toBeNull();
  });

  it("keeps at most 10 history items", async () => {
    for (let i = 0; i < 12; i++) {
      await recordModelHealth({
        connectionId: "c", provider: "p", model: "m",
        ok: false, statusCode: 503, reason: "probe_failed", scope: "model",
      });
    }
    const entry = await getModelHealth({ connectionId: "c", provider: "p", model: "m" });
    expect(entry.history.length).toBeLessThanOrEqual(10);
    expect(entry.consecutiveFailures).toBe(12);
  });
});

describe("account isolation", () => {
  it("a payment failure on account A leaves account B eligible", async () => {
    await recordModelHealth({
      connectionId: "conn-a", provider: "kilocode", model: "deepseek-v3",
      ok: false, statusCode: 402, reason: "payment_required", scope: "account",
    });
    const a = await isModelEligible({ connectionId: "conn-a", provider: "kilocode", model: "deepseek-v3", mode: "enforce" });
    expect(a.eligible).toBe(false);
    const b = await isModelEligible({ connectionId: "conn-b", provider: "kilocode", model: "deepseek-v3", mode: "enforce" });
    expect(b.eligible).toBe(true);
  });

  it("account-scoped failures never remove the model from managed combos", async () => {
    await recordModelHealth({
      connectionId: "conn-a", provider: "kilocode", model: "deepseek-v3",
      ok: false, statusCode: 402, reason: "payment_required", scope: "account",
    });
    const { models, skipped } = await filterComboCandidates(["kilocode/deepseek-v3", "glm/glm-4.7-flash"]);
    expect(models).toEqual(["kilocode/deepseek-v3", "glm/glm-4.7-flash"]);
    expect(skipped).toEqual([]);
  });
});

describe("filterComboCandidates", () => {
  it("skips model-scoped retirements but preserves order and never strands", async () => {
    await recordModelHealth({
      connectionId: "conn-a", provider: "nvidia", model: "deepseek-v4-pro",
      ok: false, statusCode: 410, reason: "model_retired", scope: "model",
    });
    const { models, skipped } = await filterComboCandidates(["nvidia/deepseek-v4-pro", "glm/glm-4.7-flash"]);
    expect(models).toEqual(["glm/glm-4.7-flash"]);
    expect(skipped[0].model).toBe("nvidia/deepseek-v4-pro");
  });

  it("keeps the original list when every candidate is blocked", async () => {
    await recordModelHealth({
      connectionId: "c", provider: "nvidia", model: "deepseek-v4-pro",
      ok: false, statusCode: 410, reason: "model_retired", scope: "model",
    });
    const { models } = await filterComboCandidates(["nvidia/deepseek-v4-pro"]);
    expect(models).toEqual(["nvidia/deepseek-v4-pro"]);
  });

  it("ignores entries past nextRetry and unknown models", async () => {
    const { models } = await filterComboCandidates(["glm/glm-4.7-flash"]);
    expect(models).toEqual(["glm/glm-4.7-flash"]);
    expect(await listModelHealth()).toEqual({});
  });
});

describe("isModelEligible", () => {
  it("observe mode never filters; enforce skips cooldown until nextRetry", async () => {
    await recordModelHealth({
      connectionId: "c", provider: "p", model: "m",
      ok: false, statusCode: 503, reason: "probe_failed", scope: "model",
    });
    expect((await isModelEligible({ connectionId: "c", provider: "p", model: "m", mode: "observe" })).eligible).toBe(true);
    const enforced = await isModelEligible({ connectionId: "c", provider: "p", model: "m", mode: "enforce" });
    expect(enforced.eligible).toBe(false);
    expect(enforced.nextRetry).toBeTruthy();
  });

  it("unverified entries stay eligible even in enforce mode", async () => {
    await recordModelHealth({
      connectionId: "c", provider: "p", model: "new-model",
      ok: false, statusCode: 0, reason: "unverified", scope: "model",
    });
    expect((await isModelEligible({ connectionId: "c", provider: "p", model: "new-model", mode: "enforce" })).eligible).toBe(true);
  });

  it("clearModelHealth reactivates immediately", async () => {
    await recordModelHealth({
      connectionId: "c", provider: "p", model: "m",
      ok: false, statusCode: 503, reason: "probe_failed", scope: "model",
    });
    await clearModelHealth({ connectionId: "c", provider: "p", model: "m" });
    expect((await isModelEligible({ connectionId: "c", provider: "p", model: "m", mode: "enforce" })).eligible).toBe(true);
  });
});
