import { describe, expect, it } from "vitest";
import { normalizeSystemoneUsage } from "open-sse/handlers/systemoneCore.js";

describe("normalizeSystemoneUsage", () => {
  it("maps Cloudflare Workers AI usage shape (prompt_tokens/completion_tokens)", () => {
    expect(
      normalizeSystemoneUsage({ prompt_tokens: 120, completion_tokens: 30 })
    ).toEqual({ prompt_tokens: 120, completion_tokens: 30 });
  });

  it("maps OpenAI-style usage shape (input_tokens/output_tokens)", () => {
    expect(
      normalizeSystemoneUsage({ input_tokens: 50, output_tokens: 10 })
    ).toEqual({ prompt_tokens: 50, completion_tokens: 10 });
  });

  it("prefers prompt_tokens/completion_tokens over input/output variants", () => {
    expect(
      normalizeSystemoneUsage({
        prompt_tokens: 7,
        completion_tokens: 2,
        input_tokens: 999,
        output_tokens: 999,
      })
    ).toEqual({ prompt_tokens: 7, completion_tokens: 2 });
  });

  it("keeps explicit zeros instead of falling back", () => {
    expect(
      normalizeSystemoneUsage({ prompt_tokens: 0, completion_tokens: 0 })
    ).toEqual({ prompt_tokens: 0, completion_tokens: 0 });
  });

  it("defaults missing fields to 0", () => {
    expect(normalizeSystemoneUsage({ prompt_tokens: 5 })).toEqual({
      prompt_tokens: 5,
      completion_tokens: 0,
    });
    expect(normalizeSystemoneUsage({ output_tokens: 3 })).toEqual({
      prompt_tokens: 0,
      completion_tokens: 3,
    });
  });

  it("returns null when upstream has no usage object", () => {
    expect(normalizeSystemoneUsage(undefined)).toBeNull();
    expect(normalizeSystemoneUsage(null)).toBeNull();
    expect(normalizeSystemoneUsage("nope")).toBeNull();
    expect(normalizeSystemoneUsage({})).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
    });
  });
});
