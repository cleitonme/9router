import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

vi.mock("@/models", () => ({
  getProviderNodeById: vi.fn(),
}));

const originalFetch = global.fetch;
const { POST: validateProvider } = await import(
  "../../src/app/api/providers/validate/route.js"
);

const makeRequest = () =>
  new Request("http://localhost/api/providers/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "nace", apiKey: "nace-key" }),
  });

describe("Nace provider validation route", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("validates the key through the System One endpoint", async () => {
    global.fetch.mockResolvedValue(new Response("{}", { status: 200 }));

    const response = await validateProvider(makeRequest());
    expect(await response.json()).toEqual({ valid: true, error: null });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("https://console.nace.ai/v1/systemone");
    expect(options.headers.Authorization).toBe("Bearer nace-key");
    const body = JSON.parse(options.body);
    expect(body.model).toBe("drex-max");
    expect(body.state).toBe("ping");
    expect(body.questions.probe.type).toBe("noul");
  });

  it("reports a rejected key", async () => {
    global.fetch.mockResolvedValue(new Response("{}", { status: 401 }));

    const response = await validateProvider(makeRequest());
    expect(await response.json()).toEqual({
      valid: false,
      error: "Invalid API key",
    });
  });
});
