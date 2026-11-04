import { describe, expect, it } from "vitest";
import { reorderByCapabilities } from "../../open-sse/services/combo.js";

describe("combo latency optimization", () => {
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