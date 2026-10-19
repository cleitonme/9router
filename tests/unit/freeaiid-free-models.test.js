import { describe, it, expect } from "vitest";
import freeaiid from "../../open-sse/providers/registry/freeaiid.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getProviderModels, getDefaultModel } from "../../open-sse/config/providerModels.js";

describe("freeaiid (free.ai.id) free models", () => {
  const ids = freeaiid.models.map((m) => m.id);

  it("registers the live free relay pool ids", () => {
    expect(ids).toContain("glm-5.3-flash-free");
    expect(ids).toContain("mimo-v2.6-flash-free");
    expect(ids).toContain("ovh-free/gpt-oss-120b");
    expect(ids).toContain("notrack/gpt-5");
  });

  it("does not seed premium-only models", () => {
    expect(ids).not.toContain("jev-1.13-free");
  });

  it("is passthrough so any live id resolves", () => {
    expect(freeaiid.passthroughModels).toBe(true);
  });

  it("transport targets the free.ai.id OpenAI-compatible gateway", () => {
    expect(PROVIDERS.freeaiid.baseUrl).toBe("https://free.ai.id/v1/chat/completions");
    expect(PROVIDER_MODELS.faid.length).toBe(38);
    expect(getProviderModels("faid")[0].id).toBe("glm-5.3-flash-free");
    expect(getDefaultModel("faid")).toBe("glm-5.3-flash-free");
  });

  it("caps resolve for the seeded ids", () => {
    const glm = getCapabilitiesForModel("freeaiid", "glm-5.3-flash-free");
    expect(glm.reasoning).toBe(true);
    expect(glm.thinkingEffortSupported).toBe(true);
    expect(getCapabilitiesForModel("freeaiid", "mimo-v2.6-flash-free").reasoning).toBe(true);
  });
});
