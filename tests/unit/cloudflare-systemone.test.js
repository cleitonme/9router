import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSystemoneCore } from "open-sse/handlers/systemoneCore.js";

// proxyAwareFetch captures the real global fetch at module load, so stub the
// module and delegate to the currently stubbed global (same pattern as
// systemone-combo.test.js).
const { proxyFetchSpy } = vi.hoisted(() => ({
  proxyFetchSpy: vi.fn((url, options) => globalThis.fetch(url, options)),
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: proxyFetchSpy,
  default: proxyFetchSpy,
}));

const answers = { is_urgent: { type: "noul", noul: 0.9477 } };
const usage = { input_tokens: 162, output_tokens: 0 };

async function call(provider, model, upstreamBody, credentials = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(upstreamBody), { status: 200 }))
  );
  const result = await handleSystemoneCore({
    body: { state: "s", questions: { is_urgent: { type: "noul", instructions: "i" } } },
    modelInfo: { provider, model },
    credentials,
    log: { debug: () => {}, info: () => {}, warn: () => {} },
  });
  expect(result.success).toBe(true);
  return { result, json: await result.response.json() };
}

describe("handleSystemoneCore response", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    proxyFetchSpy.mockClear();
  });

  it("unwraps Cloudflare's { result } envelope", async () => {
    // Shape returned by api.cloudflare.com/client/v4/accounts/<id>/ai/run/@cf/cloudflare/clef-flash
    const { result, json } = await call(
      "cloudflare-ai",
      "@cf/cloudflare/clef-flash",
      { result: { model: "clef-flash", answers, usage }, success: true, errors: [], messages: [] },
      { apiKey: "k", providerSpecificData: { accountId: "acc" } }
    );

    expect(json).toEqual({ model: "clef-flash", answers, usage });
    expect(result.usage).toEqual({ prompt_tokens: 162, completion_tokens: 0 });
  });

  it("forwards an unwrapped System One body untouched", async () => {
    const body = { model: "jev-1.13-free", answers, usage };
    const { json } = await call("opencode", "jev-1.13-free", body, { apiKey: "k" });
    expect(json).toEqual(body);
  });
});
