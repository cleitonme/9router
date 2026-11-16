import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MEDIA, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { isLikelyNonChatModelId } from "../../open-sse/config/catalogConfig.js";

describe("AvalAI provider", () => {
  const entry = REGISTRY.find((e) => e.id === "avalai");

  it("is registered in the free-tier category and requires an API key", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("freeTier");
    expect(entry.hasFree).toBe(true);
    expect(entry.authType).toBe("apikey");
    expect(entry.authModes).toContain("apikey");
    expect(entry.noAuth).toBeUndefined();
    expect(entry.alias).toBe("avalai");
    expect(entry.aliases).toContain("aval-ai");
    expect(entry.uiAlias).toBe("avalai");
  });

  it("points at the AvalAI endpoints without duplicating /v1", () => {
    expect(PROVIDERS.avalai.baseUrl).toBe("https://api.avalai.ir/v1/chat/completions");
    expect(PROVIDERS.avalai.validateUrl).toBe("https://api.avalai.ir/v1/models");
    expect(PROVIDERS.avalai.format).toBe("openai");
    expect(PROVIDERS.avalai.baseUrl).not.toContain("/v1/v1");
    expect(PROVIDERS.avalai.validateUrl).not.toContain("/v1/v1");
  });

  it("seeds only chat models, never non-chat ids", () => {
    expect(entry.models.length).toBeGreaterThan(0);
    for (const model of entry.models) {
      expect(typeof model.id).toBe("string");
      expect(isLikelyNonChatModelId(model.id)).toBe(false);
    }
  });

  it("does not seed higher-tier (paid) models from the PR", () => {
    const ids = new Set(entry.models.map((m) => m.id));
    // min_tier 2 in the live catalogue — must never be offered as free.
    expect(ids.has("claude-fable-5-2")).toBe(false);
    expect(ids.has("claude-sonnet-4-20250514")).toBe(false);
    // min_tier 0 free-usable models are present.
    expect(ids.has("deepseek-v4.1-flash")).toBe(true);
    expect(ids.has("gpt-6.1-terra")).toBe(true);
  });

  it("keeps the alias-keyed model matrix in sync", () => {
    const ids = PROVIDER_MODELS.avalai.map((m) => m.id);
    expect(ids).toEqual(entry.models.map((m) => m.id));
    expect(PROVIDER_MEDIA.avalai.modelsFetcher).toEqual({
      url: "https://api.avalai.ir/public/models",
      type: "avalai-free",
    });
  });

  it("accepts live ids via passthrough", () => {
    expect(entry.passthroughModels).toBe(true);
  });

  it("routes through the shared DefaultExecutor (no custom adapter)", () => {
    expect(getExecutor("avalai")).toBeInstanceOf(DefaultExecutor);
  });

  it("keeps every registry id unique after adding avalai", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
