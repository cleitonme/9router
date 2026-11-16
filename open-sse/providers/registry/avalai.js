// AvalAI (https://avalai.ir) — Iranian OpenAI-compatible gateway.
// Verified 2026-11-15 against the public catalogue https://api.avalai.ir/public/models
// (list, 353 entries) and https://docs.avalai.ir/en/guides/setup-9router:
//   GET  /v1/models           -> 401 without a key (Bearer required).
//   POST /v1/chat/completions -> OpenAI wire format; /v1/responses on a separate node.
// AvalAI has no $0 chat models. "Free" here means min_tier 0: callable on a free
// account without buying a paid tier. New accounts get 25,000 Tomans on email
// signup and up to 200,000 after phone verification; usage is metered afterwards,
// so the notice says so instead of claiming a permanent free tier.
// Every seeded id below is min_tier 0 chat (checked against the catalogue) with
// the published context/output limits; higher tiers and non-chat ids are excluded.
// The suggestions filter keeps the same rule for ids discovered at runtime.
export default {
  id: "avalai",
  priority: 25,
  hasFree: true,
  alias: "avalai",
  aliases: ["aval-ai"],
  uiAlias: "avalai",
  display: {
    name: "AvalAI",
    icon: "smart_toy",
    color: "#0066CC",
    textIcon: "AV",
    website: "https://avalai.ir",
    notice: {
      text: "API key required. New accounts receive up to 200,000 Tomans of free credit and tier-0 models need no paid tier; usage is metered afterwards.",
      apiKeyUrl: "https://dashboard.avalai.ir/api-keys",
      signupUrl: "https://avalai.ir",
    },
  },
  category: "freeTier",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://api.avalai.ir/v1/chat/completions",
    validateUrl: "https://api.avalai.ir/v1/models",
  },
  models: [
    { id: "gpt-6.1-terra", name: "GPT-6.1 Terra", contextLength: 922000, maxOutputTokens: 128000 },
    { id: "gpt-6-sol", name: "GPT-6 Sol", contextLength: 922000, maxOutputTokens: 128000 },
    { id: "gpt-6-luna", name: "GPT-6 Luna", contextLength: 922000, maxOutputTokens: 128000 },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", contextLength: 922000, maxOutputTokens: 128000 },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextLength: 922000, maxOutputTokens: 128000 },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextLength: 922000, maxOutputTokens: 128000 },
    { id: "gpt-5.5", name: "GPT-5.5", contextLength: 1050000, maxOutputTokens: 128000 },
    { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", contextLength: 272000, maxOutputTokens: 128000 },
    { id: "gpt-4.1", name: "GPT-4.1", contextLength: 1047576, maxOutputTokens: 32768 },
    { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", contextLength: 1047576, maxOutputTokens: 32768 },
    { id: "gpt-oss-120b", name: "GPT-OSS 120B", contextLength: 128000, maxOutputTokens: 128000 },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", contextLength: 1000000, maxOutputTokens: 128000 },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextLength: 200000, maxOutputTokens: 64000 },
    { id: "gemini-4-carbon", name: "Gemini 4 Carbon", contextLength: 1048576, maxOutputTokens: 1048576 },
    { id: "gemini-4-argon", name: "Gemini 4 Argon", contextLength: 1048576, maxOutputTokens: 1048576 },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", contextLength: 1048576, maxOutputTokens: 65536 },
    { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", contextLength: 1048576, maxOutputTokens: 65536 },
    { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", contextLength: 1048576, maxOutputTokens: 65535 },
    { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", contextLength: 1048576, maxOutputTokens: 65536 },
    { id: "grok-4.7", name: "Grok 4.7", contextLength: 500000, maxOutputTokens: 500000 },
    { id: "grok-4.6", name: "Grok 4.6", contextLength: 500000, maxOutputTokens: 500000 },
    { id: "grok-4.5", name: "Grok 4.5", contextLength: 500000, maxOutputTokens: 500000 },
    { id: "grok-4-fast-reasoning", name: "Grok 4 Fast Reasoning", contextLength: 2000000, maxOutputTokens: 2000000 },
    { id: "grok-code-fast-1", name: "Grok Code Fast 1", contextLength: 256000, maxOutputTokens: 256000 },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextLength: 1000000, maxOutputTokens: 393216 },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextLength: 1000000, maxOutputTokens: 393216 },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextLength: 1000000, maxOutputTokens: 393216 },
    { id: "deepseek-v3.2", name: "DeepSeek V3.2", contextLength: 163840, maxOutputTokens: 163840 },
    { id: "glm-5.3", name: "GLM-5.3", contextLength: 991000, maxOutputTokens: 128000 },
    { id: "glm-5.3-flash", name: "GLM-5.3 Flash", contextLength: 991000, maxOutputTokens: 128000 },
    { id: "glm-5.2", name: "GLM-5.2", contextLength: 991000, maxOutputTokens: 128000 },
    { id: "kimi-k3", name: "Kimi K3", contextLength: 262144, maxOutputTokens: 262144 },
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", contextLength: 262144, maxOutputTokens: 262144 },
    { id: "minimax-m3", name: "MiniMax M3", contextLength: 512000, maxOutputTokens: 128000 },
    { id: "minimax-m3.1-flash", name: "MiniMax M3.1 Flash", contextLength: 1048576, maxOutputTokens: 1048576 },
    { id: "minimax-m2.7-highspeed", name: "MiniMax M2.7 Highspeed", contextLength: 204800, maxOutputTokens: 131072 },
    { id: "qwen3.8-flash", name: "Qwen3.8 Flash", contextLength: 991000, maxOutputTokens: 128000 },
    { id: "qwen3.8-27b", name: "Qwen3.8 27B", contextLength: 262144 },
    { id: "qwen3.7-plus", name: "Qwen3.7 Plus", contextLength: 1000000, maxOutputTokens: 65536 },
    { id: "qwen3.7-max", name: "Qwen3.7 Max", contextLength: 997952, maxOutputTokens: 65536 },
    { id: "qwen3-coder-flash", name: "Qwen3 Coder Flash", contextLength: 997952, maxOutputTokens: 65536 },
    { id: "muse-spark-open", name: "Muse Spark Open", contextLength: 1048576 },
    { id: "nemotron-3-ultra", name: "Nemotron 3 Ultra", contextLength: 254000, maxOutputTokens: 64000 },
    { id: "nemotron-3.5-lightning", name: "Nemotron 3.5 Lightning", contextLength: 262144 },
    { id: "llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout 17B 16E Instruct", contextLength: 10000000, maxOutputTokens: 16384 },
    { id: "sonar", name: "Sonar", contextLength: 128000, maxOutputTokens: 128000 },
    { id: "sonar-pro", name: "Sonar Pro", contextLength: 200000, maxOutputTokens: 8000 },
    { id: "sonar-reasoning", name: "Sonar Reasoning", contextLength: 128000, maxOutputTokens: 128000 },
    { id: "cf.phonellm-mini-alpha-2", name: "Cloudflare PhoneLLM Mini Alpha 2", contextLength: 262140 },
    { id: "cf.eurollm-9b-it", name: "Cloudflare EuroLLM 9B IT", contextLength: 32768 },
    { id: "cf.apertus-v1.5-8b", name: "Cloudflare Apertus v1.5 8B", contextLength: 262144 },
    { id: "cf.moondream3.1-9b-a2b", name: "Cloudflare Moondream 3.1 9B A2B", contextLength: 32768, maxOutputTokens: 32768 },
  ],
  serviceKinds: ["llm", "imageToText"],
  // Public catalogue: no key needed (the authenticated /v1/models is used by the
  // connection test instead). The filter keeps only min_tier 0 chat ids, so free
  // ids added by AvalAI appear without a code change; passthroughModels accepts
  // any id at runtime (billing is enforced upstream, not by this list).
  modelsFetcher: { url: "https://api.avalai.ir/public/models", type: "avalai-free" },
  passthroughModels: true,
};
