import { describe, it, expect, beforeEach } from "vitest";
import {
  MAX_STICKY_SESSIONS,
  STICKY_SESSION_TTL_MS,
  buildStickySignature,
  clearStickySession,
  getStickyModel,
  getStickySessionCount,
  normalizeStickyPolicy,
  normalizeSwitchThreshold,
  resetStickyStore,
  resolveStickyRouting,
  setStickyModel,
} from "../../open-sse/services/comboStickiness.js";

const MODELS = ["p/strong", "p/mid", "p/cheap"];

beforeEach(() => {
  resetStickyStore();
});

describe("normalizers", () => {
  it("normalizes policies and falls back to smart", () => {
    expect(normalizeStickyPolicy(" STRICT ")).toBe("strict");
    expect(normalizeStickyPolicy("per-turn")).toBe("per-turn");
    expect(normalizeStickyPolicy("custom")).toBe("custom");
    expect(normalizeStickyPolicy("nonsense")).toBe("smart");
    expect(normalizeStickyPolicy(null)).toBe("smart");
  });

  it("accepts ratio or percentage thresholds", () => {
    expect(normalizeSwitchThreshold(0.8)).toBe(0.8);
    expect(normalizeSwitchThreshold(80)).toBe(0.8);
    expect(normalizeSwitchThreshold(0)).toBe(0.8);
    expect(normalizeSwitchThreshold("bad")).toBe(0.8);
    expect(normalizeSwitchThreshold(150)).toBe(1);
  });

  it("builds a policy signature that ignores the threshold for strict/per-turn", () => {
    expect(buildStickySignature("smart", 0.8)).toBe("smart:0.8");
    expect(buildStickySignature("custom", 70)).toBe("custom:0.7");
    expect(buildStickySignature("strict", 0.9)).toBe("strict");
    expect(buildStickySignature("per-turn", 0.9)).toBe("per-turn");
  });
});

describe("sticky store", () => {
  it("stores and reads a session model", () => {
    setStickyModel("combo-a", "session-1", "p/mid", "smart:0.8", 1000);
    expect(getStickyModel("combo-a", "session-1", MODELS, "smart:0.8", 1000)).toBe("p/mid");
  });

  it("isolates combo and session keys", () => {
    setStickyModel("combo-a", "session-1", "p/mid", "smart:0.8", 1000);
    setStickyModel("combo-a", "session-2", "p/cheap", "smart:0.8", 1000);
    setStickyModel("combo-b", "session-1", "p/strong", "smart:0.8", 1000);

    expect(getStickyModel("combo-a", "session-1", MODELS, "smart:0.8", 1000)).toBe("p/mid");
    expect(getStickyModel("combo-a", "session-2", MODELS, "smart:0.8", 1000)).toBe("p/cheap");
    expect(getStickyModel("combo-b", "session-1", MODELS, "smart:0.8", 1000)).toBe("p/strong");
  });

  it("expires entries after the TTL", () => {
    setStickyModel("combo-a", "session-1", "p/mid", "smart:0.8", 1000);
    expect(getStickyModel("combo-a", "session-1", MODELS, "smart:0.8", 1000 + STICKY_SESSION_TTL_MS + 1)).toBeNull();
    expect(getStickySessionCount()).toBe(0);
  });

  it("drops a lock when the model left the combo", () => {
    setStickyModel("combo-a", "session-1", "p/mid", "smart:0.8", 1000);
    expect(getStickyModel("combo-a", "session-1", ["p/strong", "p/cheap"], "smart:0.8", 1000)).toBeNull();
  });

  it("drops a lock when the combo policy changed", () => {
    setStickyModel("combo-a", "session-1", "p/mid", "smart:0.8", 1000);
    expect(getStickyModel("combo-a", "session-1", MODELS, "strict", 1000)).toBeNull();
  });

  it("clears one session, one combo, or everything", () => {
    setStickyModel("combo-a", "s1", "p/mid", "smart:0.8", 1000);
    setStickyModel("combo-a", "s2", "p/cheap", "smart:0.8", 1000);
    setStickyModel("combo-b", "s1", "p/strong", "smart:0.8", 1000);

    clearStickySession("combo-a", "s1");
    expect(getStickyModel("combo-a", "s1", MODELS, "smart:0.8", 1000)).toBeNull();
    expect(getStickyModel("combo-a", "s2", MODELS, "smart:0.8", 1000)).toBe("p/cheap");

    clearStickySession("combo-a");
    expect(getStickyModel("combo-a", "s2", MODELS, "smart:0.8", 1000)).toBeNull();
    expect(getStickyModel("combo-b", "s1", MODELS, "smart:0.8", 1000)).toBe("p/strong");

    clearStickySession();
    expect(getStickySessionCount()).toBe(0);
  });

  it("bounds memory by pruning expired entries and the oldest quarter", () => {
    for (let i = 0; i < MAX_STICKY_SESSIONS; i++) {
      setStickyModel("combo", `s${i}`, "p/mid", "smart:0.8", 1000);
    }
    expect(getStickySessionCount()).toBe(MAX_STICKY_SESSIONS);

    setStickyModel("combo", "overflow", "p/mid", "smart:0.8", 1000);
    expect(getStickySessionCount()).toBeLessThan(MAX_STICKY_SESSIONS);
    expect(getStickyModel("combo", "overflow", MODELS, "smart:0.8", 1000)).toBe("p/mid");
  });
});

describe("resolveStickyRouting", () => {
  it("per-turn ignores locks and picks the candidate", () => {
    const result = resolveStickyRouting({
      models: MODELS,
      candidateModel: "p/cheap",
      confidence: 0.99,
      policy: "per-turn",
      stickyModel: "p/mid",
    });
    expect(result.models).toEqual(["p/cheap", "p/strong", "p/mid"]);
    expect(result.stickyModel).toBeNull();
    expect(result.reason).toBe("per-turn");
  });

  it("strict lock reuses the session model without a candidate", () => {
    const result = resolveStickyRouting({
      models: MODELS,
      candidateModel: null,
      confidence: null,
      policy: "strict",
      stickyModel: "p/mid",
    });
    expect(result.models).toEqual(["p/mid", "p/strong", "p/cheap"]);
    expect(result.stickyModel).toBe("p/mid");
    expect(result.reason).toBe("strict-lock");
  });

  it("smart keeps the lock when the candidate did not change", () => {
    const result = resolveStickyRouting({
      models: MODELS,
      candidateModel: "p/mid",
      confidence: 0.95,
      policy: "smart",
      threshold: 0.8,
      stickyModel: "p/mid",
    });
    expect(result.models).toEqual(["p/mid", "p/strong", "p/cheap"]);
    expect(result.switched).toBe(false);
    expect(result.reason).toBe("keep");
  });

  it("smart keeps the lock below the confidence threshold", () => {
    const result = resolveStickyRouting({
      models: MODELS,
      candidateModel: "p/cheap",
      confidence: 0.79,
      policy: "smart",
      threshold: 0.8,
      stickyModel: "p/mid",
    });
    expect(result.models[0]).toBe("p/mid");
    expect(result.switched).toBe(false);
    expect(result.reason).toBe("keep");
  });

  it("smart switches when the candidate changed with enough confidence", () => {
    const result = resolveStickyRouting({
      models: MODELS,
      candidateModel: "p/cheap",
      confidence: 0.9,
      policy: "smart",
      threshold: 0.8,
      stickyModel: "p/mid",
    });
    expect(result.models).toEqual(["p/cheap", "p/strong", "p/mid"]);
    expect(result.stickyModel).toBe("p/cheap");
    expect(result.switched).toBe(true);
    expect(result.reason).toBe("switch");
  });

  it("accepts percentage thresholds and custom policy", () => {
    const result = resolveStickyRouting({
      models: MODELS,
      candidateModel: "p/cheap",
      confidence: 0.85,
      policy: "custom",
      threshold: 85,
      stickyModel: "p/mid",
    });
    expect(result.switched).toBe(true);
    expect(result.stickyModel).toBe("p/cheap");
  });

  it("selects the initial candidate when there is no lock", () => {
    const result = resolveStickyRouting({
      models: MODELS,
      candidateModel: "p/mid",
      confidence: 0.9,
      policy: "smart",
    });
    expect(result.models).toEqual(["p/mid", "p/strong", "p/cheap"]);
    expect(result.stickyModel).toBe("p/mid");
    expect(result.reason).toBe("initial");
  });

  it("supports tier-map candidates outside the combo", () => {
    const result = resolveStickyRouting({
      models: MODELS,
      candidateModel: "p/external",
      confidence: 0.9,
      policy: "smart",
      allowedModels: [...MODELS, "p/external"],
    });
    expect(result.models).toEqual(["p/external", ...MODELS]);
    expect(result.stickyModel).toBe("p/external");
  });

  it("keeps the current lock when classification produced no candidate", () => {
    const result = resolveStickyRouting({
      models: MODELS,
      candidateModel: null,
      confidence: null,
      policy: "smart",
      stickyModel: "p/cheap",
    });
    expect(result.models).toEqual(["p/cheap", "p/strong", "p/mid"]);
    expect(result.stickyModel).toBe("p/cheap");
    expect(result.reason).toBe("keep");
  });

  it("returns the original order and no lock when nothing is available", () => {
    const result = resolveStickyRouting({
      models: MODELS,
      candidateModel: null,
      confidence: null,
      policy: "smart",
    });
    expect(result.models).toEqual(MODELS);
    expect(result.stickyModel).toBeNull();
    expect(result.reason).toBe("no-candidate");
  });

  it("ignores a lock that is no longer part of the combo", () => {
    const result = resolveStickyRouting({
      models: MODELS,
      candidateModel: null,
      policy: "strict",
      stickyModel: "p/gone",
    });
    expect(result.models).toEqual(MODELS);
    expect(result.stickyModel).toBeNull();
  });
});
