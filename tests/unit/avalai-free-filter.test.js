import { describe, expect, it } from "vitest";

import { FILTERS } from "../../src/app/api/providers/suggested-models/filters.js";

const filter = FILTERS["avalai-free"];

const model = (overrides = {}) => ({
  id: "some-model",
  mode: "chat",
  min_tier: 0,
  max_input_tokens: 128000,
  ...overrides,
});

describe("avalai-free suggested-models filter", () => {
  it("is registered under the -free suffix convention", () => {
    expect(typeof filter).toBe("function");
    expect(FILTERS["avalai"]).toBeUndefined();
  });

  it("keeps only min_tier 0 chat models", () => {
    const out = filter([
      model({ id: "gpt-6.1-terra", max_input_tokens: 922000 }),
      model({ id: "gemini-4-carbon" }),
      model({ id: "claude-fable-5-2", min_tier: 2 }),
      model({ id: "gpt-image-2.6-flare", mode: "image_generation" }),
    ]);

    expect(out.map((m) => m.id)).toEqual(["gemini-4-carbon", "gpt-6.1-terra"]);
  });

  it("drops non-chat ids that still report mode chat", () => {
    const out = filter([
      model({ id: "gemini-2.5-flash-tts" }),
      model({ id: "gpt-audio-mini" }),
      model({ id: "groq.llama-guard-4-12b" }),
      model({ id: "nvidia_nim.nemotron-parse" }),
      model({ id: "deepseek-v4.1-flash" }),
    ]);

    expect(out.map((m) => m.id)).toEqual(["deepseek-v4.1-flash"]);
  });

  it("fails closed when min_tier is missing or unparsable", () => {
    const out = filter([
      { id: "no-tier", mode: "chat" },
      model({ id: "string-tier", min_tier: "0" }),
      model({ id: "null-tier", min_tier: null }),
      model({ id: "tier-zero" }),
    ]);

    expect(out.map((m) => m.id)).toEqual(["tier-zero"]);
  });

  it("ignores malformed entries and sorts by id", () => {
    const out = filter([
      null,
      undefined,
      42,
      { mode: "chat", min_tier: 0 },
      { id: 123, mode: "chat", min_tier: 0 },
      model({ id: "z-model" }),
      model({ id: "a-model" }),
    ]);

    expect(out.map((m) => m.id)).toEqual(["a-model", "z-model"]);
  });

  it("derives display names and forwards the context window", () => {
    const out = filter([
      model({ id: "gpt-6.1-terra", max_input_tokens: 922000 }),
      model({ id: "gemini-4-carbon", max_input_tokens: 1048576 }),
    ]);

    expect(out).toEqual([
      { id: "gemini-4-carbon", name: "Gemini 4 Carbon", contextLength: 1048576 },
      { id: "gpt-6.1-terra", name: "GPT 6.1 Terra", contextLength: 922000 },
    ]);
  });
});
