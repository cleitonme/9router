// Model-health error classification: the 7 production log cases.
// A billing/quota failure on ONE account must never retire the model globally;
// a 410 EOL must skip the model without burning every account; 503/overload
// must stay transient and never mark a model permanently unavailable.
import { describe, expect, it } from "vitest";
import { classifyError } from "../../open-sse/utils/classifyError.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("model-health classification — production log cases", () => {
  it("KiloCode/DeepSeek 402 'Paid Model - Credits Required' → account-scoped payment", () => {
    const c = classifyError({ status: 402, bodyText: "Paid Model - Credits Required" });
    expect(c.type).toBe("payment_required");
    expect(c.scope).toBe("account");

    const fb = checkFallbackError(402, "Paid Model - Credits Required");
    expect(fb.shouldFallback).toBe(true);
    expect(fb.classification.type).toBe("payment_required");
  });

  it("NVIDIA DeepSeek V4 Pro / GLM 5.2 410 EOL → provider-scoped retirement", () => {
    for (const msg of [
      "Model reached end of life",
      "GONE: model decommissioned",
    ]) {
      const c = classifyError({ status: 410, bodyText: msg });
      expect(c.type).toBe("model_retired");
      expect(c.scope).toBe("model");
    }
    const fb = checkFallbackError(410, "Model reached end of life");
    expect(fb.shouldFallback).toBe(true);
    expect(fb.classification.type).toBe("model_retired");
  });

  it("bare 410 without wording is still a retirement, not an abort", () => {
    const c = classifyError({ status: 410, bodyText: "" });
    expect(c.type).toBe("model_retired");
    expect(checkFallbackError(410, "").shouldFallback).toBe(true);
  });

  it("Ollama cloud 402 free-plan exclusion → account scope", () => {
    const c = classifyError({ status: 402, bodyText: "not included in your free-use allowance" });
    expect(c.type).toBe("payment_required");
    expect(c.scope).toBe("account");
  });

  it("Bazaarlink 429 daily limit → quota (long model lock), still falls back", () => {
    const c = classifyError({ status: 429, bodyText: "daily limit exceeded, retry tomorrow" });
    expect(c.type).toBe("quota_exhausted");
    expect(checkFallbackError(429, "daily limit exceeded, retry tomorrow").shouldFallback).toBe(true);
  });

  it("OpenAI-compatible 503 overload → transient, never a retirement", () => {
    const c = classifyError({ status: 503, bodyText: "CPU overloaded" });
    expect(c.type).toBe("server_error");
    expect(c.retryable).toBe(true);
    const fb = checkFallbackError(503, "CPU overloaded");
    expect(fb.shouldFallback).toBe(true);
    expect(["server_error", "upstream_overload"]).toContain(fb.classification.type);
  });

  it("GLM 429 'Insufficient balance or no resource package' → account payment, not global", () => {
    const c = classifyError({ status: 429, bodyText: "Insufficient balance or no resource package" });
    expect(c.type).toBe("payment_required");
    expect(c.scope).toBe("account");
  });

  it("bare 402 with no wording → account-scoped payment (never model-dead)", () => {
    const c = classifyError({ status: 402, bodyText: "nope" });
    expect(c.type).toBe("payment_required");
    expect(c.scope).toBe("account");
  });

  it("bare 404 → model-scoped not-found (skip candidate, keep accounts)", () => {
    const c = classifyError({ status: 404, bodyText: "nope" });
    expect(c.type).toBe("model_not_found");
    expect(c.scope).toBe("model");
    expect(checkFallbackError(404, "nope").shouldFallback).toBe(true);
  });

  it("'not enabled for this account' → same 404 family but account scope", () => {
    const c = classifyError({ status: 404, bodyText: "model is not enabled for this account" });
    expect(c.type).toBe("model_not_found");
    expect(c.scope).toBe("account");
  });

  it("incompatible route wording → skips candidate instead of aborting the combo", () => {
    const c = classifyError({ status: 400, bodyText: "unknown variant custom" });
    expect(c.type).toBe("route_incompatible");
    expect(checkFallbackError(400, "unknown variant custom").shouldFallback).toBe(true);
  });

  it("plain 400 context overflow still does NOT cool the account (regression guard)", () => {
    const result = checkFallbackError(400, JSON.stringify({
      error: { message: "This model's maximum context length is 1048576 tokens.", type: "invalid_request_error" },
    }));
    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
  });

  it("401 without quota wording stays invalid_credentials", () => {
    expect(classifyError({ status: 401, bodyText: "unauthorized" }).type).toBe("invalid_credentials");
  });
});
