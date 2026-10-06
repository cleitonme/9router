import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

describe("Requesty provider", () => {
  const entry = REGISTRY.find((e) => e.id === "requesty");

  it("is registered as a free-tier provider that requires an API key", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("freeTier");
    expect(entry.hasFree).toBe(true);
    expect(entry.authType).toBe("apikey");
    expect(entry.authModes).toContain("apikey");
    // Must never be presented as a no-auth provider
    expect(entry.noAuth).toBeUndefined();
    expect(entry.alias).toBe("rq");
    expect(entry.aliases).toContain("requesty");
  });

  it("points at the default Requesty router base URL", () => {
    expect(PROVIDERS.requesty.baseUrl).toBe("https://router.requesty.ai/v1/chat/completions");
    expect(PROVIDERS.requesty.validateUrl).toBe("https://router.requesty.ai/v1/models");
    // transport.format defaults to "openai" via the shared provider default
    expect(PROVIDERS.requesty.format).toBe("openai");
  });

  it("declares no provider-wide thinkingFormat so each model resolves its own", () => {
    // Requesty forwards bodies verbatim. A provider-wide thinkingFormat
    // would force one wire format onto every model, which an OpenAI
    // endpoint rejects.
    expect(PROVIDERS.requesty.thinkingFormat).toBeUndefined();
  });

  it("enables dynamic model discovery and passthrough", () => {
    expect(entry.passthroughModels).toBe(true);
    expect(entry.modelsFetcher).toMatchObject({
      url: "https://router.requesty.ai/v1/models",
      type: "requesty-free",
    });
  });

  it("keeps seed model ids namespaced exactly as the API returns them", () => {
    const ids = (PROVIDER_MODELS.rq || []).map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("openai/gpt-4o");
    // Requesty prefixes ids by upstream vendor — namespaces must be preserved
    expect(ids.every((id) => id.includes("/"))).toBe(true);
  });

  it("routes through the shared DefaultExecutor (no custom adapter)", () => {
    expect(getExecutor("requesty")).toBeInstanceOf(DefaultExecutor);
  });

  it("resolves per-model capabilities through the vendor prefix", () => {
    // Namespaced ids must still reach the canonical family patterns.
    expect(getCapabilitiesForModel("requesty", "anthropic/claude-sonnet-4-20250514")).toMatchObject({
      vision: true,
      thinkingFormat: "claude-budget",
    });
  });

  it("does not invent capabilities for an uncatalogued model", () => {
    const caps = getCapabilitiesForModel("requesty", "some-vendor/some-unknown-model-x");
    expect(caps.vision).toBe(false);
    expect(caps.reasoning).toBe(false);
    expect(caps.thinkingFormat).toBeNull();
  });

  it("keeps every registry id unique after adding requesty", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
