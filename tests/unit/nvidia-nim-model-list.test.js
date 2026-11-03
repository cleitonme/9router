import { describe, expect, it } from "vitest";

import nvidia from "../../open-sse/providers/registry/nvidia.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// NVIDIA NIM catalogue. integrate.api.nvidia.com/v1/models needs a key, so there
// is no modelsFetcher; the seeded list is the offline fallback. Only the models
// that build.nvidia.com marks as "Free Endpoint" are seeded (plus the separate
// embedding/stt/tts service models), so the list is free-tier accurate even
// before the first keyed refresh.

describe("nvidia registry model list", () => {
    it("seeds the current free chat endpoints", () => {
        const ids = nvidia.models.map((m) => m.id);
        for (const id of [
            "deepseek-ai/deepseek-v4.1-flash",
            "z-ai/glm-5.3-flash",
            "minimaxai/minimax-m3.1-flash",
            "mistralai/mistral-large-4-1t-a52b",
            "google/gemma-4-31b-it",
            "meta/muse-glimmer-30b",
            "nvidia/nemotron-3.5-lightning-30b-a3b",
            "nvidia/nemotron-3-ultra-550b-a55b",
            "openai/gpt-oss-20b",
            "poolside/laguna-xs-2.1",
            "stepfun-ai/step-5-preview",
        ]) {
            expect(ids, id).toContain(id);
        }
    });

    it("does not seed paid/partner endpoints", () => {
        const ids = nvidia.models.map((m) => m.id);
        for (const id of [
            "moonshotai/kimi-k3",
            "z-ai/glm-5.3",
            "z-ai/glm-5.2",
            "qwen/qwen3.5-397b-a17b",
            "thinkingmachines/inkling",
            "deepseek-ai/deepseek-v4-pro",
            "deepseek-ai/deepseek-v4-flash",
        ]) {
            expect(ids, id).not.toContain(id);
        }
    });

    it("keeps the non-chat service models (embedding/stt/tts)", () => {
        const byId = Object.fromEntries(nvidia.models.map((m) => [m.id, m]));
        expect(byId["nvidia/nv-embedqa-e5-v5"].kind).toBe("embedding");
        expect(byId["nvidia/parakeet-ctc-1.1b-asr"].kind).toBe("stt");
        expect(byId["fastpitch"].kind).toBe("tts");
        expect(byId["tacotron2"].kind).toBe("tts");
    });

    it("has no duplicate ids", () => {
        const ids = nvidia.models.map((m) => m.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("gives every model a display name", () => {
        for (const m of nvidia.models) {
            expect(typeof m.name, m.id).toBe("string");
            expect(m.name.length, m.id).toBeGreaterThan(0);
        }
    });

    it("accepts unknown ids so a newer NIM model works without a registry edit", () => {
        expect(nvidia.passthroughModels).toBe(true);
    });

    it("declares no modelsFetcher, since the endpoint needs a key", () => {
        expect(nvidia.modelsFetcher).toBeUndefined();
    });

    it("declares an authenticated live catalog plus the free-endpoint source", () => {
        // Fetched server-side with the connection key; never through the public
        // suggested-models proxy.
        expect(nvidia.catalog?.url).toBe("https://integrate.api.nvidia.com/v1/models");
        expect(nvidia.catalog?.auth).toBe("bearer");
        expect(nvidia.catalog?.kind).toBe("chat");
        expect(nvidia.catalog?.freeEndpoints).toMatchObject({
            url: "https://build.nvidia.com/models",
            filter: "nimType:nim_type_preview",
        });
    });

    it("drops the retired GLM 5.3 seed (EOL on 2026-10-28)", () => {
        expect(nvidia.models.map((m) => m.id)).not.toContain("z-ai/glm-5.3");
    });

    it("does not list models that chat/completions cannot serve", () => {
        // Image-gen / video / embedding-only models are served from other
        // endpoints and would 400 here.
        const ids = nvidia.models.map((m) => m.id);
        for (const id of [
            "black-forest-labs/flux.1-dev",
            "black-forest-labs/flux_2-klein-4b",
            "nvidia/cosmos-predict1-5b",
            "nvidia/sparsedrive",
            "nvidia/nv-embed-v1",
            "baai/bge-m3",
            "meta/esmfold",
            "meta/llama-guard-4-12b",
        ]) {
            expect(ids, id).not.toContain(id);
        }
    });
});

describe("newly-seeded nvidia models resolve real capabilities", () => {
    // The router keys off these: a wrong `vision` silently strips images and a
    // wrong `reasoning` drops thinking.
    it.each([
        ["deepseek-ai/deepseek-v4.1-flash", { reasoning: true, vision: true }],
        ["nvidia/nemotron-3.5-lightning-30b-a3b", { reasoning: true }],
        ["z-ai/glm-5.3-flash", { reasoning: true, vision: true }],
        ["nvidia/nemotron-3-ultra-550b-a55b", { reasoning: true }],
        ["openai/gpt-oss-20b", { reasoning: true }],
    ])("%s", (id, want) => {
        const c = getCapabilitiesForModel("nvidia", id);
        for (const [k, v] of Object.entries(want)) expect(c[k], `${id}.${k}`).toBe(v);
    });

    it("does not claim vision for a text-only model", () => {
        // deepseek-v4 is text-in/text-out in the catalogue.
        expect(getCapabilitiesForModel("nvidia", "deepseek-ai/deepseek-v4-pro-0813").vision).toBe(false);
    });

    it("is provider-independent — the same id resolves the same way elsewhere", () => {
        // capabilities.js is keyed on the model, not the connection, so seeding a
        // model under nvidia must not change how it resolves for another provider.
        for (const id of ["nvidia/nemotron-3-super-120b-a12b", "z-ai/glm-5.3"]) {
            expect(getCapabilitiesForModel("someone-else", id), id)
                .toEqual(getCapabilitiesForModel("nvidia", id));
        }
    });
});
