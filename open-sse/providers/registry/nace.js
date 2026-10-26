export default {
  id: "nace",
  priority: 48,
  alias: "nace",
  aliases: ["drex"],
  uiAlias: "nace",
  display: {
    name: "Nace Drex",
    icon: "psychology",
    color: "#1D1D16",
    textIcon: "DX",
    website: "https://console.nace.ai",
    notice: {
      text: "Drex decision models on the System One protocol (noul / choice / score questions, calibrated probabilities). drex-max also accepts a top-level `images` array; drex-v2.0 is text-only. Paste a console.nace.ai API key (sent as a Bearer token).",
      apiKeyUrl: "https://console.nace.ai/dashboard/api-keys",
    },
  },
  category: "apikey",
  authType: "apikey",
  models: [
    { id: "drex-max", name: "Drex Max", kind: "systemone" },
    { id: "drex-v2.0", name: "Drex 2.0", kind: "systemone" },
  ],
  serviceKinds: ["systemone"],
  systemoneConfig: {
    baseUrl: "https://console.nace.ai/v1/systemone",
    path: "/v1/systemone",
    authType: "apikey",
    authHeader: "bearer",
  },
};
