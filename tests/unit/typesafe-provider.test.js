import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDER_MEDIA } from "../../open-sse/providers/index.js";
import { getProvidersByKind } from "@/shared/constants/providers";
import { discoverSystemoneModels } from "open-sse/services/systemoneRouting.js";

describe("typesafe official System One provider", () => {
  const entry = REGISTRY.find((e) => e.id === "typesafe");

  it("is registered as an apikey System One provider", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("apikey");
    expect(entry.alias).toBe("ts");
    expect(entry.priority).toBe(50);
    expect(entry.serviceKinds).toEqual(["systemone"]);
    expect(PROVIDER_MEDIA["typesafe"]?.systemoneConfig?.baseUrl).toBe(
      "https://api.typesafe.ai/v1/systemone"
    );
  });

  it("appears in getProvidersByKind('systemone')", () => {
    const list = getProvidersByKind("systemone");
    const found = list.find((p) => p.id === "typesafe");
    expect(found).toBeDefined();
    expect(found.alias).toBe("ts");
    expect(found.systemoneConfig?.baseUrl).toBe("https://api.typesafe.ai/v1/systemone");
  });

  it("seeds jev-latest as the default model", () => {
    const ids = (entry.models || []).filter((m) => m.kind === "systemone").map((m) => m.id);
    expect(ids).toContain("jev-latest");
  });

  it("joins zero-config auto discovery after v1m by priority", async () => {
    const models = await discoverSystemoneModels({
      entries: REGISTRY,
      hasCredentials: async () => true,
      isBlocked: () => false,
    });
    expect(models[0]).toBe("oc/jev-1.13-free");
    expect(models).toContain("ts/jev-latest");
    // priority order among configured: openrouter(10) < v1m(45) < typesafe(50) < ocz(205)
    const idx = (m) => models.indexOf(m);
    expect(idx("ts/jev-latest")).toBeGreaterThan(idx("v1m/rev-latest"));
    expect(idx("ts/jev-latest")).toBeLessThan(idx("ocz/jev-1.13-free"));
  });

  it("is skipped by discovery without credentials", async () => {
    const models = await discoverSystemoneModels({
      entries: REGISTRY,
      hasCredentials: async (id) => id !== "typesafe",
      isBlocked: () => false,
    });
    expect(models).not.toContain("ts/jev-latest");
  });
});
