import { describe, expect, it } from "vitest";

import { __textInputForModel } from "../../src/lib/services/catalogModelDev.js";

// The raw catalogue stores non-text modalities in "i" and, since v3, an
// explicit "t" flag for text input. A text+image model has i=["image"] but must
// still count as text-capable, otherwise the chat filter drops every multimodal
// chat model (e.g. deepseek-ai/deepseek-v4.1-flash).
describe("catalogModelDev - text input detection", () => {
  it("accepts a text+image model (v3 flag)", () => {
    expect(__textInputForModel({ i: ["image"], t: true })).toBe(true);
  });

  it("rejects an image-only model (v3 flag)", () => {
    expect(__textInputForModel({ i: ["image"], t: false })).toBe(false);
  });

  it("accepts a text-only model (empty i)", () => {
    expect(__textInputForModel({ i: [], t: true })).toBe(true);
  });

  it("falls back to the legacy heuristic when t is absent", () => {
    // Legacy text+image was indistinguishable from image-only.
    expect(__textInputForModel({ i: ["image"] })).toBe(false);
    expect(__textInputForModel({ i: [] })).toBe(true);
  });

  it("returns null for an unknown model", () => {
    expect(__textInputForModel(undefined)).toBeNull();
  });
});
