import { describe, expect, it, vi } from "vitest";
import { handleComboChat, reorderByCapabilities } from "../../open-sse/services/combo.js";

const healthMock = vi.hoisted(() => ({
  entries: {
    "conn-a|nvidia/model-a": { latencyMs: 800 },
    "conn-b|nvidia/model-b": { latencyMs: 200 },
    "conn-c|nvidia/model-c": { latencyMs: 500 },
  },
}));

vi.mock("../../src/lib/modelHealth/service.js", () => ({
  listModelHealth: async () => healthMock.entries,
  recordModelHealth: async () => {},
}));

const MODELS = ["nvidia/model-a", "nvidia/model-b", "nvidia/model-c"];

async function runCombo({ latencySort }) {
  const tried = [];
  const response = await handleComboChat({
    body: { messages: [{ role: "user", content: "hi" }] },
    models: MODELS,
    handleSingleModel: async (_body, model) => {
      tried.push(model);
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    log: { info: () => {}, warn: () => {} },
    comboName: "test-combo",
    comboStrategy: "fallback",
    latencySort,
  });
  return { tried, response };
}

describe("combo latency optimization", () => {
  describe("handleComboChat latency sort opt-in", () => {
    it("keeps the registered order when latencySort is off", async () => {
      const { tried, response } = await runCombo({ latencySort: false });
      expect(response.ok).toBe(true);
      expect(tried[0]).toBe("nvidia/model-a");
    });

    it("keeps the registered order when latencySort is omitted", async () => {
      const { tried } = await runCombo({ latencySort: undefined });
      expect(tried[0]).toBe("nvidia/model-a");
    });

    it("tries the fastest model first when latencySort is on", async () => {
      const { tried, response } = await runCombo({ latencySort: true });
      expect(response.ok).toBe(true);
      expect(tried[0]).toBe("nvidia/model-b");
    });
  });

  describe("reorderByCapabilities with latency", () => {
    it("sorts by latency within same tier when latencyMap provided and required set", () => {
      const models = [
        "nvidia/model-a",
        "nvidia/model-b",
        "nvidia/model-c",
      ];
      const latencyMap = new Map();
      latencyMap.set("nvidia/model-a", 500);
      latencyMap.set("nvidia/model-b", 1200);
      latencyMap.set("nvidia/model-c", 800);

      // All text-only models, same tier (tier 2 due to no required capabilities in hard)
      const result = reorderByCapabilities(models, new Set(["vision"]), latencyMap);
      
      // Order by tier (all same tier 2) then latency
      expect(result[0]).toBe("nvidia/model-a"); // fastest
      expect(result[1]).toBe("nvidia/model-c"); // medium
      expect(result[2]).toBe("nvidia/model-b"); // slowest
    });

    it("prioritizes capability over latency", () => {
      const models = [
        "nvidia/model-a", // text-only
        "nvidia/model-vision", // vision
      ];
      
      const latencyMap = new Map();
      latencyMap.set("nvidia/model-a", 500);      // very fast
      latencyMap.set("nvidia/model-vision", 1200); // slower

      // Vision model should come first even if slower
      const result = reorderByCapabilities(models, new Set(["vision"]), latencyMap);
      expect(result[0]).toBe("nvidia/model-vision");
      expect(result[1]).toBe("nvidia/model-a");
    });

    it("handles missing latency as Infinity (worst priority)", () => {
      const models = [
        "nvidia/fast-model",
        "nvidia/slow-model",
      ];
      const latencyMap = new Map();
      latencyMap.set("nvidia/fast-model", 500);
      // slow-model not in map

      const result = reorderByCapabilities(models, new Set(["vision"]), latencyMap);
      expect(result[0]).toBe("nvidia/fast-model");
      expect(result[1]).toBe("nvidia/slow-model");
    });

    it("returns original order when no required capabilities", () => {
      const models = [
        "nvidia/model-a",
        "nvidia/model-b",
        "nvidia/model-c",
      ];
      const result = reorderByCapabilities(models, new Set());
      expect(result).toEqual(models);
    });

    it("stable sort: maintains original order for equal latency", () => {
      const models = [
        "nvidia/model-a",
        "nvidia/model-b", 
        "nvidia/model-c",
      ];
      
      const latencyMap = new Map();
      latencyMap.set("nvidia/model-a", 500);
      latencyMap.set("nvidia/model-b", 500);  // same as a
      latencyMap.set("nvidia/model-c", 800);

      const result = reorderByCapabilities(models, new Set(["vision"]), latencyMap);
      
      // Model A and B should maintain original order (stable sort)
      expect(result[0]).toBe("nvidia/model-a");
      expect(result[1]).toBe("nvidia/model-b");
      expect(result[2]).toBe("nvidia/model-c");
    });
  });
});