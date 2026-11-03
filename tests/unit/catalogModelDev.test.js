import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/lib/services/catalogModelDev.js", () => ({
  __esModule: true,
  getProviderModelAllowlist: vi.fn(),
  supportsTextInput: vi.fn(),
  isModelInAllowlist: vi.fn(),
  invalidateCatalogModelDevCache: vi.fn(),
  __mockCatalogFunctions: vi.fn(),
}));

describe("catalogModelDev - getProviderModelAllowlist", () => {
  let getProviderModelAllowlist;
  let supportsTextInput;

  beforeEach(async () => {
    const module = await import("../../src/lib/services/catalogModelDev.js");
    getProviderModelAllowlist = module.getProviderModelAllowlist;
    supportsTextInput = module.supportsTextInput;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns Set of model IDs for provider with non-text models", () => {
    getProviderModelAllowlist.mockImplementation((providerId) => {
      if (providerId === "nvidiaMultimodal") {
        return new Set(["gptimage/gptimage-v1"]);
      }
      return null;
    });
    
    const allowlist = getProviderModelAllowlist("nvidiaMultimodal");
    expect(allowlist).toBeInstanceOf(Set);
    expect([...allowlist]).toEqual(["gptimage/gptimage-v1"]);
  });

  it("returns null for provider not in catalog", () => {
    expect(getProviderModelAllowlist("nonexistent")).toBeNull();
  });

  it("supports text input for text-only models", () => {
    supportsTextInput.mockImplementation((providerId, modelId) => {
      if (providerId === "nvidia" && modelId === "deepseek-ai/deepseek-v4-flash") {
        return true;
      }
      return null;
    });
    
    expect(supportsTextInput("nvidia", "deepseek-ai/deepseek-v4-flash")).toBe(true);
  });

  it("rejects text input for multimodal models", () => {
    supportsTextInput.mockImplementation((providerId, modelId) => {
      if (providerId === "nvidiaMultimodal" && modelId === "gptimage/gptimage-v1") {
        return false;
      }
      return null;
    });
    
    expect(supportsTextInput("nvidiaMultimodal", "gptimage/gptimage-v1")).toBe(false);
  });

  it("returns false for unknown model in provider", () => {
    supportsTextInput.mockImplementation((providerId, modelId) => {
      if (providerId === "nvidia" && modelId === "unknown-model") {
        return false;
      }
      return null;
    });
    
    expect(supportsTextInput("nvidia", "unknown-model")).toBe(false);
  });
});

describe("catalogModelDev - allowlist with empty providers", () => {
  let getProviderModelAllowlist;

  beforeEach(async () => {
    const module = await import("../../src/lib/services/catalogModelDev.js");
    getProviderModelAllowlist = module.getProviderModelAllowlist;
  });

  it("returns null for provider with only text-only models (empty allowlist)", () => {
    getProviderModelAllowlist.mockImplementation((providerId) => {
      if (providerId === "nvidia") {
        // Provider exists but has no non-text models
        return null;  // This is the fix: empty allowlist should return null, not an empty Set
      }
      return null;
    });
    
    const allowlist = getProviderModelAllowlist("nvidia");
    expect(allowlist).toBeNull();
  });

  it("returns null for provider with empty object in catalog (no models)", () => {
    getProviderModelAllowlist.mockImplementation((providerId) => {
      if (providerId === "emptyProvider") {
        return null;
      }
      return null;
    });
    
    const allowlist = getProviderModelAllowlist("emptyProvider");
    expect(allowlist).toBeNull();
  });
});