import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDER_MEDIA } from "../../open-sse/providers/index.js";
import { getProvidersByKind } from "@/shared/constants/providers";

describe("freeaiid System One provider", () => {
  const entry = REGISTRY.find((e) => e.id === "freeaiid");

  it("is registered as a System One provider alongside llm", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("freeTier");
    expect(entry.serviceKinds).toEqual(["llm", "systemone"]);
    expect(PROVIDER_MEDIA["freeaiid"]?.systemoneConfig?.baseUrl).toBe("https://free.ai.id/v1/systemone");
  });

  it("appears in getProvidersByKind('systemone')", () => {
    const list = getProvidersByKind("systemone");
    const found = list.find((p) => p.id === "freeaiid");
    expect(found).toBeDefined();
    expect(found.alias).toBe("faid");
    expect(found.systemoneConfig?.baseUrl).toBe("https://free.ai.id/v1/systemone");
  });

  it("exposes the documented jev-1.13-free decision model", () => {
    const jev = entry.models.find((m) => m.id === "jev-1.13-free");
    expect(jev).toBeDefined();
    expect(jev.kind).toBe("systemone");
  });
});
