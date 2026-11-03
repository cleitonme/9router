// Provider-catalog combo builder: ordering, retired/disabled filtering, seed
// fallback and durable-health skipping. Upstream + DB are mocked so this stays
// a unit test.
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  disabled: vi.fn(),
  filter: vi.fn(),
}));

vi.mock("@/lib/services/providerCatalog.js", () => ({
  canonicalProviderId: (id) => id,
  getProviderRegistryEntry: () => ({ id: "nvidia", alias: "nvidia", hasFree: true }),
  getStaticChatModels: () => [
    { id: "static-a", name: "Static A" },
    { id: "static-b", name: "Static B" },
  ],
  isCatalogProvider: () => true,
  refreshProviderCatalog: mocks.refresh,
}));

vi.mock("@/lib/db/repos/disabledModelsRepo.js", () => ({
  getDisabledByProvider: mocks.disabled,
}));

vi.mock("@/lib/modelHealth/service.js", () => ({
  filterComboCandidates: mocks.filter,
}));

import { buildProviderCatalogComboModels } from "@/lib/services/providerCatalogCombo.js";

beforeEach(() => {
  mocks.refresh.mockReset();
  mocks.disabled.mockReset().mockResolvedValue([]);
  mocks.filter.mockReset().mockImplementation(async (candidates) => ({
    models: candidates,
    skipped: [],
  }));
});

const baseConfig = { provider: "nvidia", refreshSchedule: "daily" };

describe("buildProviderCatalogComboModels", () => {
  it("orders curated models first, appends new ids, and filters retired/disabled/non-chat", async () => {
    mocks.refresh.mockResolvedValue({
      provider: "nvidia",
      fetchedAt: "2026-11-03T00:00:00Z",
      models: [
        { id: "new-chat", name: "New Chat" },
        { id: "static-b", name: "Static B" },
        { id: "static-a", name: "Static A" },
        { id: "gone", name: "Gone" },
        { id: "off", name: "Off" },
        { id: "acme/embed-v9", name: "Embed" },
      ],
      retired: [{ id: "gone", at: "2026-10-28T08:00:00Z", source: "upstream_410" }],
      error: null,
    });
    mocks.disabled.mockResolvedValue(["off"]);

    const built = await buildProviderCatalogComboModels(baseConfig);

    expect(built.models).toEqual([
      "nvidia/static-a",
      "nvidia/static-b",
      "nvidia/new-chat",
    ]);
    expect(built.fetchedAt).toBe("2026-11-03T00:00:00Z");
    expect(built.warning).toBeNull();
    expect(built.details.find((d) => d.providerModelId === "new-chat")?.isNew).toBe(true);
    expect(built.details.find((d) => d.providerModelId === "static-a")?.isNew).toBe(false);
  });

  it("falls back to the curated seed when upstream returns nothing", async () => {
    mocks.refresh.mockResolvedValue({
      provider: "nvidia",
      fetchedAt: null,
      models: [],
      retired: [],
      error: "HTTP 500",
    });

    const built = await buildProviderCatalogComboModels(baseConfig);

    expect(built.models).toEqual(["nvidia/static-a", "nvidia/static-b"]);
    expect(built.warning).toBe("HTTP 500");
  });

  it("never clears the list when the refresh throws", async () => {
    mocks.refresh.mockRejectedValue(new Error("network down"));

    const built = await buildProviderCatalogComboModels(baseConfig);

    expect(built.models).toEqual(["nvidia/static-a", "nvidia/static-b"]);
    expect(built.warning).toContain("network down");
  });

  it("applies the limit after all filters", async () => {
    mocks.refresh.mockResolvedValue({
      models: [
        { id: "static-a" },
        { id: "static-b" },
        { id: "new-chat" },
      ],
      retired: [],
      fetchedAt: "2026-11-03T00:00:00Z",
    });

    const built = await buildProviderCatalogComboModels({ ...baseConfig, limit: 1 });
    expect(built.models).toEqual(["nvidia/static-a"]);
  });

  it("respects excludeKeywords against id and display name", async () => {
    mocks.refresh.mockResolvedValue({
      models: [
        { id: "static-a", name: "Static A" },
        { id: "static-b", name: "Thinking Model" },
      ],
      retired: [],
      fetchedAt: "2026-11-03T00:00:00Z",
    });

    const built = await buildProviderCatalogComboModels({
      ...baseConfig,
      excludeKeywords: ["thinking"],
    });
    expect(built.models).toEqual(["nvidia/static-a"]);
  });

  it("drops candidates blocked in durable model health", async () => {
    mocks.refresh.mockResolvedValue({
      models: [{ id: "static-a" }, { id: "static-b" }],
      retired: [],
      fetchedAt: "2026-11-03T00:00:00Z",
    });
    mocks.filter.mockResolvedValue({
      models: ["nvidia/static-a"],
      skipped: [{ model: "nvidia/static-b", reason: "model_retired" }],
    });

    const built = await buildProviderCatalogComboModels(baseConfig);
    expect(built.models).toEqual(["nvidia/static-a"]);
    expect(built.skipped).toHaveLength(1);
    expect(built.details).toHaveLength(1);
  });
});
