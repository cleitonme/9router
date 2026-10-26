import { describe, expect, it, vi } from "vitest";
import {
  isSystemoneOnlyProvider,
  probeSystemoneProvider,
} from "open-sse/services/systemoneValidation.js";

const NACE_URL = "https://console.nace.ai/v1/systemone";

describe("System One provider validation", () => {
  it("detects System One-only providers", () => {
    expect(isSystemoneOnlyProvider("nace")).toBe(true);
    expect(isSystemoneOnlyProvider("v1m")).toBe(true);
    expect(isSystemoneOnlyProvider("typesafe")).toBe(true);
    expect(isSystemoneOnlyProvider("ollama")).toBe(false);
    expect(isSystemoneOnlyProvider("openai")).toBe(false);
  });

  it("probes Nace with bearer auth and a native decision payload", async () => {
    let sentUrl = null;
    let sentOptions = null;
    const fetchImpl = vi.fn(async (url, options) => {
      sentUrl = url;
      sentOptions = options;
      return new Response("{}", { status: 200 });
    });

    const result = await probeSystemoneProvider({
      provider: "nace",
      model: "drex-max",
      apiKey: "nace-key",
      fetchImpl,
    });

    expect(result).toEqual({ valid: true, error: null });
    expect(sentUrl).toBe(NACE_URL);
    expect(sentOptions.headers.Authorization).toBe("Bearer nace-key");
    const body = JSON.parse(sentOptions.body);
    expect(body.model).toBe("drex-max");
    expect(body.state).toBe("ping");
    expect(body.questions.probe.type).toBe("noul");
  });

  it("honors a saved baseUrl override", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const result = await probeSystemoneProvider({
      provider: "nace",
      model: "drex-max",
      apiKey: "nace-key",
      providerSpecificData: { baseUrl: "https://gateway.example/v1/" },
      fetchImpl,
    });

    expect(result.valid).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://gateway.example/v1/systemone");
  });

  it("rejects 401/403 and accepts other upstream errors", async () => {
    const unauthorized = await probeSystemoneProvider({
      provider: "nace",
      model: "drex-max",
      apiKey: "bad",
      fetchImpl: vi.fn(async () => new Response("{}", { status: 401 })),
    });
    expect(unauthorized).toEqual({ valid: false, error: "Invalid API key" });

    const unprocessable = await probeSystemoneProvider({
      provider: "nace",
      model: "drex-max",
      apiKey: "good",
      fetchImpl: vi.fn(async () => new Response("{}", { status: 422 })),
    });
    expect(unprocessable).toEqual({ valid: true, error: null });
  });

  it("skips providers that also serve LLM traffic", async () => {
    const fetchImpl = vi.fn();
    const result = await probeSystemoneProvider({
      provider: "ollama",
      model: "test",
      apiKey: "k",
      fetchImpl,
    });

    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
