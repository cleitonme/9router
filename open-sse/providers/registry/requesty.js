export default {
  id: "requesty",
  priority: 20,
  hasFree: true,
  alias: "rq",
  aliases: ["requesty"],
  uiAlias: "rq",
  display: {
    name: "Requesty",
    icon: "route",
    color: "#10B981",
    textIcon: "RQ",
    website: "https://app.requesty.ai",
    notice: {
      text: "API key required. Requesty reports ~200 free requests/day on its free plan; this limit is set by the provider and may change.",
      apiKeyUrl: "https://app.requesty.ai",
    },
  },
  category: "freeTier",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://router.requesty.ai/v1/chat/completions",
    validateUrl: "https://router.requesty.ai/v1/models",
  },
  // Minimal offline seed (canonical ids from Requesty's own API docs). The live
  // catalogue rotates, so it is fetched via modelsFetcher and any other id is
  // accepted via passthroughModels. Ids keep their provider namespace verbatim.
  models: [
    { id: "openai/gpt-4o", name: "GPT-4o" },
    { id: "anthropic/claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ],
  modelsFetcher: { url: "https://router.requesty.ai/v1/models", type: "requesty-free" },
  passthroughModels: true,
};
