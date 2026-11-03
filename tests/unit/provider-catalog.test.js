// Provider catalogue service: live snapshot cache + retired overlay.
// Uses the real sqlite kv layer with the providerCatalog scope cleaned per test.
import { describe, expect, it, beforeEach, vi } from "vitest";

// Mock catalogs.dev allowlist BEFORE any imports that use it
vi.mock("../src/lib/services/catalogModelDev.js", () => ({
  __esModule: true,
  getProviderModelAllowlist: () => null,
  supportsTextInput: () => true,
  isModelInAllowlist: () => null,
  invalidateCatalogModelDevCache: () => {},
}));

import { getAdapter } from "@/lib/db/driver.js";
import { setProviderCatalogEntry } from "@/lib/db/repos/providerCatalogRepo.js";
import {
  canonicalProviderId,
  filterChatModels,
  getCatalogModelIds,
  isCatalogProvider,
  isModelRetired,
  isModelBroken,
  markModelRetired,
  markModelBroken,
  normalizeCatalogModels,
} from "@/lib/services/providerCatalog.js";

beforeEach(async () => {
  const db = await getAdapter();
  db.run("DELETE FROM kv WHERE scope = 'providerCatalog'");
});

describe("catalog capability detection", () => {
  it("only providers declaring a catalog are catalog-capable", () => {
    expect(isCatalogProvider("nvidia")).toBe(true);
    expect(isCatalogProvider("glm")).toBe(false);
    expect(isCatalogProvider("openai")).toBe(false);
    expect(isCatalogProvider("")).toBe(false);
  });

  it("resolves registry aliases to the canonical provider id", () => {
    expect(canonicalProviderId("nvidia")).toBe("nvidia");
    expect(canonicalProviderId("does-not-exist")).toBe("does-not-exist");
  });
});

describe("normalizeCatalogModels", () => {
  it("accepts a bare array and the common envelope shapes", () => {
    expect(normalizeCatalogModels([{ id: "a" }])).toEqual([{ id: "a", name: "a" }]);
    expect(normalizeCatalogModels({ data: [{ id: "a" }] })).toEqual([{ id: "a", name: "a" }]);
    expect(normalizeCatalogModels({ models: [{ id: "a" }] })).toEqual([{ id: "a", name: "a" }]);
    expect(normalizeCatalogModels({ results: [{ id: "a" }] })).toEqual([{ id: "a", name: "a" }]);
  });

  it("reads id from id/name/model and dedupes", () => {
    const got = normalizeCatalogModels([
      { id: "x" },
      { name: "y" },
      { model: "z" },
      { id: "x" },
      {},
    ]);
    expect(got.map((m) => m.id)).toEqual(["x", "y", "z"]);
  });

  it("returns an empty list for junk input", () => {
    expect(normalizeCatalogModels(null)).toEqual([]);
    expect(normalizeCatalogModels({})).toEqual([]);
    expect(normalizeCatalogModels("nope")).toEqual([]);
  });
});

describe("filterChatModels", () => {
  it("drops curated non-chat models by their explicit kind", () => {
    const got = filterChatModels("nvidia", [
      { id: "nvidia/nv-embedqa-e5-v5" },
      { id: "nvidia/parakeet-ctc-1.1b-asr" },
      { id: "deepseek-ai/deepseek-v4-pro" },
    ]);
    expect(got.map((m) => m.id)).toEqual(["deepseek-ai/deepseek-v4-pro"]);
  });

  it("drops unknown non-chat ids via the shared heuristic", () => {
    const got = filterChatModels("nvidia", [
      { id: "acme/embed-v9" },
      { id: "acme/brand-new-chat" },
    ]);
    expect(got.map((m) => m.id)).toEqual(["acme/brand-new-chat"]);
  });
});

describe("retired overlay", () => {
  it("excludes retired ids from the routable catalogue", async () => {
    await setProviderCatalogEntry("nvidia", {
      provider: "nvidia",
      fetchedAt: new Date().toISOString(),
      models: [{ id: "a" }, { id: "b" }],
      retired: [{ id: "b", at: "2026-01-01T00:00:00Z", source: "upstream_410" }],
      broken: [],
    });

    const ids = await getCatalogModelIds("nvidia");
    expect([...ids]).toEqual(["a"]);

    const cached = await import("@/lib/db/repos/providerCatalogRepo.js")
      .then((repo) => repo.getProviderCatalogEntry("nvidia"));
    expect(isModelRetired(cached, "b")).toBe(true);
    expect(isModelRetired(cached, "a")).toBe(false);
  });

  it("returns null for a provider without a catalogue", async () => {
    expect(await getCatalogModelIds("glm")).toBeNull();
  });

  it("returns null while the cache is empty", async () => {
    expect(await getCatalogModelIds("nvidia")).toBeNull();
  });

  it("marks a model retired once and ignores non-catalog providers", async () => {
    expect(await markModelRetired("glm", "glm-5.3")).toBe(false);

    expect(await markModelRetired("nvidia", "z-ai/glm-5.3")).toBe(true);
    expect(await markModelRetired("nvidia", "z-ai/glm-5.3")).toBe(true);

    const { getProviderCatalogEntry } = await import("@/lib/db/repos/providerCatalogRepo.js");
    const cached = await getProviderCatalogEntry("nvidia");
    expect(cached.retired).toHaveLength(1);
    expect(cached.retired[0]).toMatchObject({ id: "z-ai/glm-5.3", source: "upstream_410" });
  });
});

describe("broken overlay", () => {
  it("marks a model as broken and getCatalogModelIds excludes it", async () => {
    await setProviderCatalogEntry("nvidia", {
      provider: "nvidia",
      fetchedAt: new Date().toISOString(),
      models: [{ id: "a" }, { id: "b" }],
      retired: [],
      broken: [],
    });

    await markModelBroken("nvidia", "b", "upstream_404");

    const ids = await getCatalogModelIds("nvidia");
    expect([...ids]).toEqual(["a"]);

    const { getProviderCatalogEntry } = await import("@/lib/db/repos/providerCatalogRepo.js");
    const cached = await getProviderCatalogEntry("nvidia");
    expect(isModelBroken(cached, "b")).toBe(true);
    expect(isModelBroken(cached, "a")).toBe(false);
  });

  it("returns false for non-catalog providers", async () => {
    expect(await markModelBroken("glm", "some-model", "upstream_404")).toBe(false);
  });
});