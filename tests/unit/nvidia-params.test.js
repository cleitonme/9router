import { describe, it, expect } from "vitest";

import { stripUnsupportedParams } from "../../open-sse/translator/concerns/paramSupport.js";
import nvidiaConfig from "../../open-sse/providers/registry/nvidia.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// NVIDIA NIM hardening: strip the params it answers 400 for, cap the connect
// budget, and treat its "degraded" cluster error as a model-only cooldown.

describe("nvidia transport", () => {
  it("declares dropClientMetadata and a 90s connect timeout", () => {
    expect(nvidiaConfig.transport.quirks?.dropClientMetadata).toBe(true);
    expect(nvidiaConfig.transport.timeoutMs).toBe(90000);
  });
});

describe("nvidia param stripping", () => {
  it("drops the params NIM rejects with 400 and keeps the rest", () => {
    const payload = {
      model: "meta/llama-3.3-70b-instruct",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi", reasoning: "thinking text" },
      ],
      client_metadata: { source: "claude-code" },
      prompt_cache_key: "cache-123",
      service_tier: "default",
      anthropic_beta: ["tools-2024"],
      thinking_budget: 1024,
      user_id: "user-456",
      custom_field: "test",
      temperature: 0.7,
    };

    stripUnsupportedParams("nvidia", "meta/llama-3.3-70b-instruct", payload);

    expect(payload.client_metadata).toBeUndefined();
    expect(payload.prompt_cache_key).toBeUndefined();
    expect(payload.service_tier).toBeUndefined();
    expect(payload.anthropic_beta).toBeUndefined();
    expect(payload.thinking_budget).toBeUndefined();
    expect(payload.user_id).toBeUndefined();
    expect(payload.custom_field).toBeUndefined();
    expect(payload.temperature).toBe(0.7);
    expect(payload.messages[1].reasoning).toBeUndefined();
    expect(payload.messages[1].reasoning_content).toBe("thinking text");
  });

  it("applies through DefaultExecutor.transformRequest", () => {
    const executor = new DefaultExecutor("nvidia");
    const body = {
      model: "meta/llama-3.3-70b-instruct",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello", reasoning: "secret thought" },
      ],
      client_metadata: { source: "claude-code" },
      prompt_cache_key: "cache-key-1",
      service_tier: "auto",
    };

    const transformed = executor.transformRequest("meta/llama-3.3-70b-instruct", body);

    expect("client_metadata" in transformed).toBe(false);
    expect("prompt_cache_key" in transformed).toBe(false);
    expect("service_tier" in transformed).toBe(false);
    expect("reasoning" in transformed.messages[1]).toBe(false);
    expect(transformed.messages[1].reasoning_content).toBe("secret thought");
  });
});

describe("nvidia degraded cluster classification", () => {
  it("uses a 15m model-scoped cooldown", () => {
    const result = checkFallbackError(400, "DEGRADED function cannot be invoked", 0, "nvidia");
    expect(result.shouldFallback).toBe(true);
    expect(result.modelScoped).toBe(true);
    expect(result.cooldownMs).toBe(15 * 60 * 1000);
  });

  it("does not leak the rule to other providers", () => {
    const result = checkFallbackError(400, "DEGRADED function cannot be invoked", 0, "openai");
    expect(result.shouldFallback).toBe(false);
  });
});

describe("nvidia tool support", () => {
  it("distinguishes models that accept function calling", () => {
    expect(getCapabilitiesForModel("nvidia", "meta/llama-3.3-70b-instruct").tools).toBe(true);
    expect(getCapabilitiesForModel("nvidia", "minimaxai/minimax-m3").tools).toBe(false);
  });

  it("keeps reasoning enabled on the MiniMax/GLM overrides", () => {
    expect(getCapabilitiesForModel("nvidia", "minimaxai/minimax-m3").reasoning).toBe(true);
    expect(getCapabilitiesForModel("nvidia", "z-ai/glm-5.2").reasoning).toBe(true);
  });
});
