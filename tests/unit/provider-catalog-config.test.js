import { describe, expect, it } from "vitest";
import { validateProviderCatalogConfig } from "@/lib/services/providerCatalogCombo.js";

describe("validateProviderCatalogConfig", () => {
  it("canonicalizes a valid nvidia config and defaults to free-only", () => {
    const config = validateProviderCatalogConfig({ provider: "nvidia" });
    expect(config).toMatchObject({
      type: "provider-catalog",
      provider: "nvidia",
      refreshSchedule: "daily",
      freeOnly: true,
      limit: null,
      excludeKeywords: [],
    });
  });

  it("trims keywords and drops empty entries", () => {
    const config = validateProviderCatalogConfig({
      provider: "nvidia",
      excludeKeywords: ["  embed ", "", "rerank", 42],
    });
    expect(config.excludeKeywords).toEqual(["embed", "rerank"]);
  });

  it("rejects providers without a live catalogue", () => {
    expect(() => validateProviderCatalogConfig({ provider: "glm" }))
      .toThrow(/no live catalogue/);
  });

  it("rejects a missing provider", () => {
    expect(() => validateProviderCatalogConfig({}))
      .toThrow(/Provider is required/);
  });

  it("rejects an unknown refresh schedule", () => {
    expect(() => validateProviderCatalogConfig({ provider: "nvidia", refreshSchedule: "minutely" }))
      .toThrow(/Invalid refresh schedule/);
  });

  it("rejects a limit outside 1..50", () => {
    expect(() => validateProviderCatalogConfig({ provider: "nvidia", limit: 0 }))
      .toThrow(/between 1 and 50/);
    expect(() => validateProviderCatalogConfig({ provider: "nvidia", limit: 51 }))
      .toThrow(/between 1 and 50/);
    expect(() => validateProviderCatalogConfig({ provider: "nvidia", limit: 1.5 }))
      .toThrow(/between 1 and 50/);
  });

  it("keeps an explicit freeOnly=false", () => {
    expect(validateProviderCatalogConfig({ provider: "nvidia", freeOnly: false }).freeOnly).toBe(false);
  });
});
