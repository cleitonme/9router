import { describe, expect, it, vi, afterEach } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDER_MEDIA } from "../../open-sse/providers/index.js";
import { AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers";
import { discoverSystemoneModels } from "open-sse/services/systemoneRouting.js";
import { SYSTEMONE_AUTO_ORDER } from "open-sse/config/jev.js";
import { buildSystemoneUrl, handleSystemoneCore } from "open-sse/handlers/systemoneCore.js";

// proxyAwareFetch captures globalThis.fetch at import time, so stubGlobal alone
// would not intercept the System One call. Passthrough to the current stub.
const { proxyFetchSpy } = vi.hoisted(() => ({
  proxyFetchSpy: vi.fn(async (url, options, proxyOptions) => {
    proxyFetchSpy.lastProxyOptions = proxyOptions;
    return globalThis.fetch(url, options);
  }),
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: proxyFetchSpy,
  default: proxyFetchSpy,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  proxyFetchSpy.mockClear();
  proxyFetchSpy.lastProxyOptions = null;
});

const NACE_URL = "https://console.nace.ai/v1/systemone";
const cfg = PROVIDER_MEDIA["nace"]?.systemoneConfig;
const logStub = { debug: () => {}, info: () => {}, warn: () => {} };

describe("Nace Drex System One provider", () => {
  const entry = REGISTRY.find((e) => e.id === "nace");

  it("is registered as a System One apikey provider", () => {
    expect(entry).toBeDefined();
    expect(entry.alias).toBe("nace");
    expect(entry.aliases).toEqual(["drex"]);
    expect(entry.priority).toBe(48);
    expect(entry.category).toBe("apikey");
    expect(entry.serviceKinds).toEqual(["systemone"]);
    expect(PROVIDER_MEDIA["nace"]?.systemoneConfig?.baseUrl).toBe(NACE_URL);
    expect(PROVIDER_MEDIA["nace"]?.systemoneConfig?.path).toBe("/v1/systemone");
  });

  it("appears in getProvidersByKind('systemone') with the drex alias", () => {
    const list = getProvidersByKind("systemone");
    const found = list.find((p) => p.id === "nace");
    expect(found).toBeDefined();
    expect(found.alias).toBe("nace");
    expect(found.systemoneConfig?.baseUrl).toBe(NACE_URL);
    expect(AI_PROVIDERS["nace"]?.systemoneConfig?.baseUrl).toBe(NACE_URL);
  });

  it("exposes drex-max and drex-v2.0", () => {
    const ids = (entry.models || []).filter((m) => m.kind === "systemone").map((m) => m.id);
    expect(ids).toEqual(["drex-max", "drex-v2.0"]);
  });

  it.each([
    [undefined, NACE_URL],
    ["https://gateway.example", "https://gateway.example/v1/systemone"],
    ["https://gateway.example/v1/", "https://gateway.example/v1/systemone"],
    ["https://gateway.example/v1/systemone", "https://gateway.example/v1/systemone"],
  ])("joins a saved host %s with the registry path", (host, expected) => {
    expect(buildSystemoneUrl(host, cfg)).toBe(expected);
  });

  it("joins zero-config auto discovery and the explicit auto order", async () => {
    expect(SYSTEMONE_AUTO_ORDER).toContain("nace/drex-max");
    const models = await discoverSystemoneModels({
      entries: REGISTRY,
      hasCredentials: async (id) => id === "nace",
      isBlocked: () => false,
    });
    expect(models).toContain("nace/drex-max");
    expect(models[0]).toBe("oc/jev-1.13-free");
  });

  it("forwards the native decision payload and preserves images/legend/confidence", async () => {
    let sentUrl = null;
    let sentHeaders = null;
    let sentBody = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, opts) => {
        sentUrl = url;
        sentHeaders = opts.headers;
        sentBody = JSON.parse(opts.body);
        return new Response(
          JSON.stringify({
            answer: { value: "yes" },
            legend: { value: "affirmative" },
            confidence: 0.92,
            usage: { input_tokens: 3, output_tokens: 4 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const images = [{ url: "data:image/png;base64,AAAA" }];
    const result = await handleSystemoneCore({
      body: {
        model: "nace/drex-max",
        state: "Customer is angry and asks for a refund.",
        questions: { refund: { type: "noul", instructions: "Should we refund?" } },
        images,
      },
      modelInfo: { provider: "nace", model: "drex-max" },
      credentials: { apiKey: "nace-key" },
      log: logStub,
    });

    expect(result.success).toBe(true);
    expect(sentUrl).toBe(NACE_URL);
    expect(sentHeaders.Authorization).toBe("Bearer nace-key");
    expect(sentHeaders["x-opencode-session"]).toBeUndefined();
    expect(sentBody.model).toBe("drex-max");
    expect(sentBody.state).toBe("Customer is angry and asks for a refund.");
    expect(sentBody.images).toEqual(images);
    expect(result.data.legend).toEqual({ value: "affirmative" });
    expect(result.data.confidence).toBe(0.92);
    expect(result.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4 });
  });

  it("honors a saved baseUrl override without doubling /v1", async () => {
    let sentUrl = null;
    let sentBody = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, opts) => {
        sentUrl = url;
        sentBody = JSON.parse(opts.body);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const result = await handleSystemoneCore({
      body: { state: "s", questions: {} },
      modelInfo: { provider: "nace", model: "drex-v2.0" },
      credentials: {
        apiKey: "nace-key",
        providerSpecificData: { baseUrl: "https://gateway.example/v1/" },
      },
      log: logStub,
    });

    expect(result.success).toBe(true);
    expect(sentUrl).toBe("https://gateway.example/v1/systemone");
    expect(sentBody.model).toBe("drex-v2.0");
  });
});
