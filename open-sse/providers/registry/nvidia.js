export default {
  id: "nvidia",
  priority: 20,
  hasFree: true,
  alias: "nvidia",
  display: {
    name: "NVIDIA NIM",
    icon: "developer_board",
    color: "#76B900",
    textIcon: "NV",
    website: "https://developer.nvidia.com/nim",
    notice: {
      text: "Free access for NVIDIA Developer Program members (prototyping & testing).",
      apiKeyUrl: "https://build.nvidia.com/settings/api-keys",
    },
  },
  category: "freeTier",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
    validateUrl: "https://integrate.api.nvidia.com/v1/models",
    // NIM's cluster discovery can exceed the 60s default connect budget on a
    // cold/degraded gateway; cap it at 90s instead of failing the request.
    timeoutMs: 90000,
    quirks: {
      dropClientMetadata: true,
    },
  },
  // Authenticated live catalog. Read by src/lib/services/providerCatalog.js to
  // keep /v1/models and provider-catalog combos in sync with upstream (new ids
  // appear, retired ones disappear) without editing this file.
  catalog: {
    url: "https://integrate.api.nvidia.com/v1/models",
    auth: "bearer",
    kind: "chat",
    // /v1/models mixes paid/partner endpoints and stale ids without saying which
    // ones a free key can actually call. build.nvidia.com marks the free ones
    // with the "Free Endpoint" badge (nimType=nim_type_preview); the catalog
    // filter intersects the live ids with that set (slug/API separators are
    // normalized). Falls back to models.dev when the page cannot be fetched.
    freeEndpoints: {
      url: "https://build.nvidia.com/models",
      filter: "nimType:nim_type_preview",
    },
  },
  // NIM's catalogue is large and moves fast. integrate.api.nvidia.com/v1/models
  // requires a key, so the authenticated `catalog` above is fetched server-side
  // with the connection's own key (never through the public suggested-models
  // proxy). The seed below mirrors the free endpoints that chat/completions can
  // serve, so the list is usable before the first keyed refresh. Non-chat free
  // endpoints (image/video/embedding/rerank/safety/tts) are omitted: they are
  // served from other endpoints, not chat.
  // passthroughModels keeps any newer id usable without a registry edit.
  models: [
    { id: "deepseek-ai/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "minimaxai/minimax-m3.1-flash", name: "MiniMax M3.1 Flash" },
    { id: "mistralai/mistral-large-4-1t-a52b", name: "Mistral Large 4" },
    { id: "google/gemma-4-31b-it", name: "Gemma 4 31B" },
    { id: "meta/llama-3.2-11b-vision-instruct", name: "Llama 3.2 11B Vision" },
    { id: "meta/llama-3.2-90b-vision-instruct", name: "Llama 3.2 90B Vision" },
    { id: "meta/muse-glimmer-30b", name: "Muse Glimmer 30B" },
    { id: "nvidia/nemotron-3.5-bolt-e4b", name: "Nemotron 3.5 Bolt E4B" },
    { id: "nvidia/nemotron-3.5-lightning-30b-a3b", name: "Nemotron 3.5 Lightning 30B" },
    { id: "nvidia/nemotron-3.5-super-vl-120b-a12b", name: "Nemotron 3.5 Super VL 120B" },
    { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", name: "Nemotron 3 Nano Omni 30B" },
    { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra" },
    { id: "nvidia/ising-calibration-1.5-31b", name: "Ising Calibration 1.5 31B" },
    { id: "openai/gpt-oss-20b", name: "GPT-OSS 20B" },
    { id: "poolside/laguna-xs-2.1", name: "Laguna XS 2.1" },
    { id: "stepfun-ai/step-5-preview", name: "Step 5 Preview" },
    { id: "nvidia/nv-embedqa-e5-v5", name: "NV EmbedQA E5 v5", kind: "embedding" },
    { id: "nvidia/parakeet-ctc-1.1b-asr", name: "Parakeet CTC 1.1B", params: ["language"], kind: "stt" },
    { id: "fastpitch", name: "FastPitch", kind: "tts" },
    { id: "tacotron2", name: "Tacotron2", kind: "tts" },
  ],
  // NIM rotates its catalogue often; an id added upstream should work the day
  // it appears rather than after a registry edit.
  passthroughModels: true,
  serviceKinds: ["llm","tts","embedding"],
  ttsConfig: {
    baseUrl: "https://integrate.api.nvidia.com/v1/audio/speech",
    authType: "apikey",
    authHeader: "bearer",
    format: "nvidia-tts",
  },
  embeddingConfig: { baseUrl: "https://integrate.api.nvidia.com/v1/embeddings", authType: "apikey", authHeader: "bearer" },
};