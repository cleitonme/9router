// Free OpenCode models that don't use the "-free" id suffix
const KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"];

// Upstream returns "Model is unavailable" for this id (2026-09-02) — re-enable when fixed
const DEAD_FREE_OPENCODE_MODELS = new Set(["deepseek-v4-flash-free"]);

export const FILTERS = {
  "openrouter-free": (models) =>
    models
      .filter(
        (m) =>
          m.pricing?.prompt === "0" &&
          m.pricing?.completion === "0" &&
          m.context_length >= 200000
      )
      .map((m) => ({ id: m.id, name: m.name, contextLength: m.context_length }))
      .sort((a, b) => b.contextLength - a.contextLength),

  "opencode-free": (models) =>
    models
      .filter((m) => (m.id?.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.includes(m.id)) && !DEAD_FREE_OPENCODE_MODELS.has(m.id))
      .map((m) => ({ id: m.id, name: m.id })),

  // Go subscription catalogue — every /models id is selectable; the endpoint lane
  // per model is resolved by the family regex (see open-sse/providers/models/helpers.js)
  "opencode-go": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => typeof m?.id === "string")
      .map((m) => ({ id: m.id, name: m.id })),

  // models.dev returns a large catalog; keep only mimo models
  "mimo-free": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => m.id?.startsWith("mimo") || m.name?.toLowerCase().includes("mimo"))
      .map((m) => ({ id: m.id, name: m.name || m.id })),

  "airforce-free": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => (m.tier === "free" || m.id?.endsWith(":free")) && m.supports_chat === true && (!m.media_type || m.media_type === "chat" || m.media_type === "text"))
      .map((m) => ({ id: m.id, name: m.name || m.id, contextLength: m.context_length }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),

  // Requesty returns pricing as an ARRAY of per-tier objects
  // ([{ input_price, output_price, ... }]), unlike OpenRouter's single object.
  // A model counts as free only when EVERY tier is zero-priced. Models without
  // trustworthy pricing metadata are excluded, never guessed as free.
  // Ids keep their provider namespace verbatim (e.g. "openai/gpt-4o").
  "requesty-free": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => typeof m?.id === "string" && isRequestyFree(m.pricing))
      .map((m) => ({ id: m.id, name: m.id, contextLength: m.context_window }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
};

// Requesty pricing tier: all price fields must be zero (or absent) for the
// tier to be free. Unknown/unparseable price fields fail closed (not free).
function isRequestyTierFree(tier) {
  if (!tier || typeof tier !== "object") return false;
  const priceFields = ["input_price", "output_price", "caching_price", "cached_price"];
  return priceFields.every((field) => {
    const value = tier[field];
    if (value === undefined || value === null) return true;
    return Number(value) === 0;
  });
}

function isRequestyFree(pricing) {
  if (!Array.isArray(pricing) || pricing.length === 0) return false;
  return pricing.every(isRequestyTierFree);
}
