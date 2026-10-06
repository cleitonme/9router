export default {
  id: "typesafe",
  priority: 50,
  alias: "ts",
  aliases: ["typesafe-ai"],
  uiAlias: "ts",
  display: {
    name: "TypeSafe",
    icon: "psychology",
    color: "#10B981",
    textIcon: "TS",
    website: "https://docs.typesafe.ai",
    notice: {
      text: "Official TypeSafe API: Jev decision models over state + typed questions (choice/score/noul). Key from the TypeSafe dashboard.",
      apiKeyUrl: "https://docs.typesafe.ai",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://api.typesafe.ai/v1/systemone",
  },
  models: [
    { id: "jev-latest", name: "Jev Latest", kind: "systemone" },
  ],
  serviceKinds: ["systemone"],
  // Native decision API: POST /v1/systemone with { model, state, questions }.
  // Docs: https://docs.typesafe.ai/api — GET /v1/models lists aliases.
  systemoneConfig: {
    baseUrl: "https://api.typesafe.ai/v1/systemone",
    authType: "apikey",
    authHeader: "bearer",
  },
  passthroughModels: true,
};
