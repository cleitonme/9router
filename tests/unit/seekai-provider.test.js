import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

describe("SeekAI provider", () => {
  const entry = REGISTRY.find((e) => e.id === "seekai");

  it("is registered in the free-providers list and requires an API key", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("freeTier");
    expect(entry.authType).toBe("apikey");
    expect(entry.authModes).toContain("apikey");
    // Must never be presented as a no-auth provider
    expect(entry.noAuth).toBeUndefined();
    expect(entry.alias).toBe("ska");
    expect(entry.aliases).toContain("seekai");
    expect(entry.uiAlias).toBe("ska");
  });

  it("does not claim confirmed free access", () => {
    // Free availability is unconfirmed (metered USD quota) — no hasFree flag,
    // and the display notice must say so instead of promising free usage.
    expect(entry.hasFree).toBeUndefined();
    expect(entry.display?.notice?.text).toMatch(/unconfirmed/i);
    expect(entry.display?.notice?.text).toMatch(/API key required/i);
  });

  it("points at the SeekAI base URL without a duplicated /v1", () => {
    expect(PROVIDERS.seekai.baseUrl).toBe("https://seekai.cc/v1/chat/completions");
    expect(PROVIDERS.seekai.validateUrl).toBe("https://seekai.cc/v1/models");
    expect(PROVIDERS.seekai.baseUrl).not.toContain("/v1/v1");
    expect(PROVIDERS.seekai.validateUrl).not.toContain("/v1/v1");
    // transport.format defaults to "openai" via the shared provider default
    expect(PROVIDERS.seekai.format).toBe("openai");
  });

  it("declares no provider-wide thinkingFormat so each model resolves its own", () => {
    expect(PROVIDERS.seekai.thinkingFormat).toBeUndefined();
  });

  it("ships no fixed model list and no public modelsFetcher", () => {
    // The catalogue is discovered live via the authenticated /v1/models
    // endpoint (it 401s without a key), so nothing is hardcoded ...
    expect(entry.models).toEqual([]);
    expect(PROVIDER_MODELS.ska).toEqual([]);
    // ... and any live id is accepted via passthrough
    expect(entry.passthroughModels).toBe(true);
    // A public (keyless) fetcher would only ever surface a 401 error page
    expect(entry.modelsFetcher).toBeUndefined();
  });

  it("routes through the shared DefaultExecutor (no custom adapter)", () => {
    expect(getExecutor("seekai")).toBeInstanceOf(DefaultExecutor);
  });

  it("resolves per-model capabilities for bare upstream ids", () => {
    // SeekAI ids are bare (no vendor namespace) and must still reach the
    // canonical family patterns.
    expect(getCapabilitiesForModel("seekai", "claude-sonnet-5")).toMatchObject({
      vision: true,
    });
  });

  it("does not invent capabilities for an uncatalogued model", () => {
    const caps = getCapabilitiesForModel("seekai", "some-unknown-model-x");
    expect(caps.vision).toBe(false);
    expect(caps.reasoning).toBe(false);
    expect(caps.thinkingFormat).toBeNull();
  });

  it("keeps every registry id unique after adding seekai", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
