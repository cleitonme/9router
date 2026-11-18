import { describe, expect, it } from "vitest";

import cloudflareAi from "../../open-sse/providers/registry/cloudflare-ai.js";

// Cloudflare Workers AI catalog refresh of 2026-11-05: these IDs stop answering
// with HTTP 410 / error 5028 on 2026-11-20.
// https://developers.cloudflare.com/changelog/post/2026-11-05-planned-model-deprecations/
const RETIRED_2026_11_20 = [
  "@cf/meta/llama-3.2-1b-instruct",
  "@cf/meta/llama-3.2-3b-instruct",
  "@cf/meta/llama-3.1-8b-instruct-fp8",
  "@cf/qwen/qwq-32b",
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/zai-org/glm-5.2",
  "@cf/zai-org/glm-5.3-flash",
  "@cf/bytedance/stable-diffusion-xl-lightning",
  "@cf/lykon/dreamshaper-8-lcm",
  "@cf/runwayml/stable-diffusion-v1-5-inpainting",
  "@cf/stabilityai/stable-diffusion-xl-base-1.0",
];

// Never existed in the Workers AI catalog (or already gone before the refresh).
const ABSENT = [
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-8b-instruct-awq",
  "@cf/moonshotai/kimi-k2.5",
  "@cf/runwayml/stable-diffusion-v1-5-img2img",
];

const ACTIVE_REPLACEMENTS = [
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  "@cf/zai-org/glm-5.3",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/qwen/qwen3.8-27b",
  "@cf/openai/gpt-oss-120b",
  "@cf/openai/gpt-oss-20b",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
];

describe("cloudflare-ai registry model seeds", () => {
  const modelIds = cloudflareAi.models.map((m) => m.id);

  it("drops every model retired on 2026-11-20", () => {
    for (const retiredId of RETIRED_2026_11_20) {
      expect(modelIds).not.toContain(retiredId);
    }
  });

  it("drops every id absent from the Workers AI catalog", () => {
    for (const absentId of ABSENT) {
      expect(modelIds).not.toContain(absentId);
    }
  });

  it("seeds the active catalog replacements", () => {
    for (const activeId of ACTIVE_REPLACEMENTS) {
      expect(modelIds).toContain(activeId);
    }
  });

  it("keeps every id unique, prefixed with @cf/ and carrying a display name", () => {
    expect(new Set(modelIds).size).toBe(modelIds.length);
    for (const m of cloudflareAi.models) {
      expect(typeof m.id).toBe("string");
      expect(m.id.startsWith("@cf/")).toBe(true);
      expect(typeof m.name).toBe("string");
      expect(m.name.length).toBeGreaterThan(0);
    }
  });

  it("keeps image models tagged with kind/image and size params", () => {
    const imageModels = cloudflareAi.models.filter((m) => m.kind === "image");
    expect(imageModels.length).toBeGreaterThan(0);
    for (const m of imageModels) {
      expect(m.params).toContain("size");
    }
  });

  it("keeps clef-flash first so the default model and System One lane stay stable", () => {
    expect(cloudflareAi.models[0]).toMatchObject({
      id: "@cf/cloudflare/clef-flash",
      kind: "systemone",
      upstreamModelId: "clef-flash",
    });
  });

  it("preserves transport configuration and provider identity", () => {
    expect(cloudflareAi.id).toBe("cloudflare-ai");
    expect(cloudflareAi.transport.baseUrl).toBe(
      "https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1/chat/completions"
    );
    expect(cloudflareAi.serviceKinds).toEqual(["llm", "image", "systemone"]);
  });
});
