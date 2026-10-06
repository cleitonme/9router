// SeekAi (https://seekai.cc) — QuantumNous New API gateway (OpenAI-compatible /v1).
// Verified 2026-10-06 against the public /api/status endpoint
// (system_name "SeekAi", v1.0.0-rc.25) plus unauthenticated probes:
//   GET  /v1/models           → 401 {"type":"new_api_error","message":"Invalid token …"}
//   POST /v1/chat/completions → rejected without a key.
// Auth is a Bearer API key on every /v1/* call. /v1/models needs a valid key,
// so there is intentionally NO modelsFetcher (a public fetch would only 401);
// discovery goes through the authenticated /api/providers/[id]/models flow.
// Upstream ids are bare (e.g. "claude-sonnet-5") — preserved verbatim.
// Free access is UNCONFIRMED (metered USD quota with top-up): no hasFree flag,
// no free claims; the notice says so explicitly.
export default {
  id: "seekai",
  priority: 30,
  alias: "ska",
  aliases: ["seekai"],
  uiAlias: "ska",
  display: {
    name: "SeekAi",
    icon: "travel_explore",
    color: "#0EA5E9",
    textIcon: "SK",
    website: "https://seekai.cc",
    notice: {
      text: "API key required. Free access is unconfirmed — usage is metered in USD with top-up; verify current terms on seekai.cc before relying on it as a free tier.",
      apiKeyUrl: "https://seekai.cc/sign-up",
    },
  },
  category: "freeTier",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://seekai.cc/v1/chat/completions",
    validateUrl: "https://seekai.cc/v1/models",
  },
  // No static seed: the catalogue is discovered live via the authenticated
  // /v1/models endpoint and any other id is accepted via passthroughModels.
  models: [],
  passthroughModels: true,
};
