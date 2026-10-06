import { describe, expect, it } from "vitest";

import { FILTERS } from "../../src/app/api/providers/suggested-models/filters.js";

const filter = FILTERS["requesty-free"];

const freeTier = (overrides = {}) => ({
  prompt_tokens_threshold: 0,
  input_price: 0,
  output_price: 0,
  caching_price: 0,
  cached_price: 0,
  ...overrides,
});

describe("requesty-free suggested-models filter", () => {
  it("is registered", () => {
    expect(typeof filter).toBe("function");
  });

  it("keeps models whose every pricing tier is zero, preserving namespaced ids", () => {
    const out = filter([
      {
        id: "openai/gpt-4o",
        context_window: 128000,
        pricing: [freeTier(), freeTier({ prompt_tokens_threshold: 200000 })],
      },
      { id: "some-vendor/some-free-model", pricing: [{ input_price: 0, output_price: 0 }] },
    ]);
    expect(out).toEqual([
      { id: "openai/gpt-4o", name: "openai/gpt-4o", contextLength: 128000 },
      { id: "some-vendor/some-free-model", name: "some-vendor/some-free-model", contextLength: undefined },
    ]);
  });

  it("excludes a model when any tier has a nonzero price", () => {
    const out = filter([
      {
        id: "vertex/claude-sonnet-4-5",
        pricing: [freeTier(), freeTier({ prompt_tokens_threshold: 200000, input_price: 0.000006 })],
      },
      {
        id: "openai/paid-model",
        pricing: [{ input_price: 0.000003, output_price: 0.000015 }],
      },
    ]);
    expect(out).toEqual([]);
  });

  it("never guesses free without trustworthy pricing metadata", () => {
    const out = filter([
      { id: "a/no-pricing", context_window: 1000 },
      { id: "b/empty-pricing", pricing: [] },
      { id: "c/null-pricing", pricing: null },
      { id: "d/string-pricing", pricing: "free" },
      { id: "e/bad-tier", pricing: ["free"] },
    ]);
    expect(out).toEqual([]);
  });

  it("drops malformed entries safely", () => {
    const out = filter([null, undefined, 42, { name: "no-id", pricing: [freeTier()] }, { id: 123, pricing: [freeTier()] }]);
    expect(out).toEqual([]);
  });

  it("returns [] for non-array payloads", () => {
    expect(filter(undefined)).toEqual([]);
    expect(filter(null)).toEqual([]);
    expect(filter({ data: [] })).toEqual([]);
  });

  it("sorts surviving models by id", () => {
    const out = filter([
      { id: "z-vendor/z-model", pricing: [freeTier()] },
      { id: "a-vendor/a-model", pricing: [freeTier()] },
    ]);
    expect(out.map((m) => m.id)).toEqual(["a-vendor/a-model", "z-vendor/z-model"]);
  });
});
