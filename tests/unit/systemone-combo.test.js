import { describe, expect, it, vi, afterEach } from "vitest";
import {
  resolveSystemoneTargets,
  sanitizeSystemoneUpstreamBody,
  buildSystemoneSuccessEnvelope,
  buildSystemoneFailureEnvelope,
  extractSystemoneAnswer,
  discoverSystemoneModels,
  pickSystemoneDefaultModel,
} from "open-sse/services/systemoneRouting.js";
import { handleSystemoneCore } from "open-sse/handlers/systemoneCore.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("systemone routing targets", () => {
  it("resolves legacy single model", async () => {
    const t = await resolveSystemoneTargets({
      model: "oc/jev-1.13-free",
      state: "s",
      questions: {},
    });
    expect(t).toEqual({ mode: "single", models: ["oc/jev-1.13-free"] });
  });

  it("resolves explicit combo mode by priority order", async () => {
    const t = await resolveSystemoneTargets({
      mode: "combo",
      models: ["oc/jev-1.13-free", "openrouter/typesafe/jev-1.13"],
      state: "s",
      questions: {},
    });
    expect(t.mode).toBe("combo");
    expect(t.models).toEqual(["oc/jev-1.13-free", "openrouter/typesafe/jev-1.13"]);
  });

  it('resolves model:"auto" with models + routing (compat shape)', async () => {
    const t = await resolveSystemoneTargets({
      model: "auto",
      models: ["oc/jev-1.13-free", "openrouter/typesafe/jev-1.13"],
      routing: { strategy: "best_available", fallback: true },
      state: "s",
      questions: {},
    });
    expect(t.mode).toBe("auto");
    expect(t.models).toHaveLength(2);
  });

  it("prefers routing.models when models is absent", async () => {
    const t = await resolveSystemoneTargets({
      mode: "auto",
      routing: { models: ["openrouter/typesafe/jev-1.13"] },
      state: "s",
      questions: {},
    });
    expect(t).toEqual({ mode: "auto", models: ["openrouter/typesafe/jev-1.13"] });
  });

  it("expands a registered combo name via lookup", async () => {
    const t = await resolveSystemoneTargets(
      { mode: "combo", model: "my-combo", state: "s", questions: {} },
      async (name) => (name === "my-combo" ? ["oc/jev-1.13-free", "openrouter/typesafe/jev-1.13"] : null)
    );
    expect(t.models).toEqual(["oc/jev-1.13-free", "openrouter/typesafe/jev-1.13"]);
  });

  it("throws MISSING_MODELS when combo/auto has no list", async () => {
    await expect(
      resolveSystemoneTargets({ mode: "combo", state: "s", questions: {} })
    ).rejects.toMatchObject({ code: "MISSING_MODELS" });
    await expect(
      resolveSystemoneTargets({ model: "auto", state: "s", questions: {} })
    ).rejects.toMatchObject({ code: "MISSING_MODELS" });
  });
});

describe("systemone envelope", () => {
  it("builds success envelope with routing metadata", () => {
    const env = buildSystemoneSuccessEnvelope({
      data: { answer: "yes", usage: { input_tokens: 1, output_tokens: 2 } },
      selectedModel: "openrouter/typesafe/jev-1.13",
      provider: "openrouter",
      mode: "auto",
      fallbackUsed: true,
      attempted: ["oc/jev-1.13-free", "openrouter/typesafe/jev-1.13"],
      usage: { prompt_tokens: 120, completion_tokens: 350 },
    });
    expect(env.success).toBe(true);
    expect(env.selected_model).toBe("openrouter/typesafe/jev-1.13");
    expect(env.provider).toBe("openrouter");
    expect(env.fallback_used).toBe(true);
    expect(env.usage.total_tokens).toBe(470);
    expect(env.answer).toBe("yes");
    // No provider keys leak through the envelope
    expect(JSON.stringify(env)).not.toMatch(/sk-|Bearer [A-Za-z0-9]/);
  });

  it("builds failure envelope without leaking internals", () => {
    const env = buildSystemoneFailureEnvelope({
      mode: "combo",
      attempted: ["oc/jev-1.13-free"],
      errors: [{ model: "oc/jev-1.13-free", status: 503, message: "down" }],
    });
    expect(env.success).toBe(false);
    expect(env.attempted).toHaveLength(1);
    expect(env.errors[0].model).toBe("oc/jev-1.13-free");
  });

  it("extractSystemoneAnswer returns null when no text field", () => {
    expect(extractSystemoneAnswer({ foo: 1 })).toBeNull();
    expect(extractSystemoneAnswer(null)).toBeNull();
  });
});

describe("systemone auto discovery (zero-config)", () => {
  const entries = [
    {
      id: "openrouter",
      alias: "openrouter",
      priority: 10,
      systemoneConfig: { baseUrl: "https://openrouter.ai/api/v1/systemone" },
      models: [{ id: "typesafe/jev-1.13", kind: "systemone" }],
    },
    {
      id: "opencode",
      alias: "oc",
      priority: 40,
      noAuth: true,
      systemoneConfig: { baseUrl: "https://opencode.ai/zen/v1/systemone" },
      models: [{ id: "jev-1.13-free", kind: "systemone" }],
    },
    {
      id: "v1m",
      alias: "v1m",
      priority: 45,
      systemoneConfig: { baseUrl: "https://v1m.ir/v1/systemone" },
      models: [
        { id: "rev-latest", kind: "systemone" },
        { id: "v1m-decision-engine", kind: "systemone" },
      ],
    },
    {
      id: "opencode-zen",
      alias: "ocz",
      priority: 205,
      systemoneConfig: { baseUrl: "https://opencode.ai/zen/v1/systemone" },
      models: [
        { id: "jev-1.13", kind: "systemone" },
        { id: "jev-1.13-free", kind: "systemone" },
      ],
    },
    // No systemone support → never a candidate
    { id: "openai", alias: "openai", priority: 1, models: [{ id: "gpt-5", kind: "llm" }] },
  ];

  it("puts noAuth free first, then configured providers by priority, free variant preferred", async () => {
    const models = await discoverSystemoneModels({
      entries,
      hasCredentials: async (id) => id === "openrouter" || id === "opencode-zen",
      isBlocked: () => false,
    });
    expect(models).toEqual([
      "oc/jev-1.13-free",
      "openrouter/typesafe/jev-1.13",
      "ocz/jev-1.13-free",
    ]);
  });

  it("works with only the noAuth lane (true zero-config)", async () => {
    const models = await discoverSystemoneModels({
      entries,
      hasCredentials: async () => false,
      isBlocked: () => false,
    });
    expect(models).toEqual(["oc/jev-1.13-free"]);
  });

  it("skips blocked providers", async () => {
    const models = await discoverSystemoneModels({
      entries,
      hasCredentials: async () => true,
      isBlocked: (id) => id === "opencode",
    });
    expect(models[0]).toBe("openrouter/typesafe/jev-1.13");
    expect(models).not.toContain("oc/jev-1.13-free");
  });

  it("returns [] when nothing is available", async () => {
    const models = await discoverSystemoneModels({
      entries: entries.filter((e) => !e.noAuth),
      hasCredentials: async () => false,
      isBlocked: () => false,
    });
    expect(models).toEqual([]);
  });

  it("pickSystemoneDefaultModel prefers free, falls back to first", () => {
    expect(pickSystemoneDefaultModel(["jev-1.13", "jev-1.13-free"])).toBe("jev-1.13-free");
    expect(pickSystemoneDefaultModel(["rev-latest", "v1m-decision-engine"])).toBe("rev-latest");
    expect(pickSystemoneDefaultModel([])).toBeNull();
  });
});

describe("systemoneCore upstream sanitization", () => {
  it("strips gateway-only routing fields before forwarding", async () => {
    let sentUrl = null;
    let sentBody = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, opts) => {
        sentUrl = url;
        sentBody = JSON.parse(opts.body);
        return new Response(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 2 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );

    const result = await handleSystemoneCore({
      body: {
        model: "openrouter/typesafe/jev-1.13",
        models: ["oc/jev-1.13-free", "openrouter/typesafe/jev-1.13"],
        mode: "combo",
        routing: { strategy: "best_available", fallback: true },
        combo: { strategy: "best_answer" },
        state: "Minha solicitação",
        questions: { is_urgent: { type: "noul", instructions: "urgent?" } },
      },
      modelInfo: { provider: "openrouter", model: "typesafe/jev-1.13" },
      credentials: { apiKey: "test-key" },
      log: { debug: () => {}, info: () => {}, warn: () => {} },
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(sentUrl).toBe("https://openrouter.ai/api/v1/systemone");
    // Upstream sees the short model id + native fields only
    expect(sentBody.model).toBe("typesafe/jev-1.13");
    expect(sentBody.state).toBe("Minha solicitação");
    expect(sentBody.questions).toBeDefined();
    expect(sentBody).not.toHaveProperty("models");
    expect(sentBody).not.toHaveProperty("mode");
    expect(sentBody).not.toHaveProperty("routing");
    expect(sentBody).not.toHaveProperty("combo");
    // sanitize helper agrees
    expect(
      sanitizeSystemoneUpstreamBody({ model: "x", models: [1], mode: "combo", state: 1, questions: {} }, "short")
    ).toEqual({ state: 1, questions: {}, model: "short" });
  });

  it("rejects providers without systemone support", async () => {
    const result = await handleSystemoneCore({
      body: { state: "s", questions: {} },
      modelInfo: { provider: "nope-not-a-provider", model: "x" },
      credentials: {},
      log: { debug: () => {} },
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
  });
});
