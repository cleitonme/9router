// Live provider catalog shared config.
// Provider endpoints live in each registry entry (`catalog`), not here.
// This file only holds the heuristics used to keep non-chat models out of the
// LLM catalogue and the refresh/TTL policy shared by the service + scheduler.

// Substring signals (lowercased before match) for models that are NOT served
// through /v1/chat/completions. Kept config-driven so a new family is a
// one-line change instead of a condition inside the service.
export const NON_CHAT_MODEL_PATTERNS = [
  // Non-chat families from models.dev observation
  "parse",
  "translate",
  "synthetic-video",
  "video-detector",
  "usdcode",
  "bevformer",
  "active-speaker",
  "voice",
  "studiovoice",
  "riva-translate",
  "riva-",
  "neva",
  "nvclip",
  "clip",
  "image",
  "imagen",
  "diffusion",
  "flux",
  "sdxl",
  "stable-diffusion",
  // Multimodal detection via models.dev modalities
  "embed",
  "embed",
  "rerank",
  "reranker",
  "retriever",
  "bge-",
  "e5-",
  "parakeet",
  "tacotron",
  "fastpitch",
  "whisper",
  "riva-tts",
  "tts",
  "asr",
  "speech",
  "audio",
  "voice",
  "cosmos",
  "sparsedrive",
  "esmfold",
  "protein",
  "flux",
  "stable-diffusion",
  "sdxl",
  "diffusion",
  "image",
  "imagen",
  "guard",
  "safety",
  "content-safety",
  "moderation",
  "reward",
  "deplot",
  "segformer",
  "mask2former",
  "oneformer",
  "grounding-dino",
  "nmt",
  "translation",
];

export function isLikelyNonChatModelId(id) {
  const lower = String(id || "").toLowerCase();
  return NON_CHAT_MODEL_PATTERNS.some((pattern) => lower.includes(pattern));
}

export const CATALOG_REFRESH_SCHEDULES = [
  "manual", "hourly", "6hours", "12hours", "daily", "weekly",
];

export const CATALOG_SCHEDULE_INTERVALS_MS = {
  hourly: 60 * 60 * 1000,
  "6hours": 6 * 60 * 60 * 1000,
  "12hours": 12 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

// A catalog fetched once a day is enough: NIM's list moves slowly and every
// refresh costs a keyed upstream call.
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
export const CATALOG_FETCH_TIMEOUT_MS = 5000;
// Avoid a refresh storm when many /v1/models calls arrive at once.
export const CATALOG_BACKGROUND_REFRESH_MIN_MS = 5 * 60 * 1000;

// Free-endpoint detection. build.nvidia.com marks the endpoints usable with a
// free key with the "Free Endpoint" badge (filter nimType=nim_type_preview);
// that page is the only public source, so it is parsed and cached to disk.
export const FREE_ENDPOINT_TTL_MS = 24 * 60 * 60 * 1000;
export const FREE_ENDPOINT_FETCH_TIMEOUT_MS = 15000;
export const FREE_ENDPOINT_MAX_PAGES = 5;
// A model marked broken (404/400) is retried after this window so a transient
// upstream failure never hides it forever.
export const MODEL_BROKEN_RECHECK_MS = 24 * 60 * 60 * 1000;

// Build slugs and API ids disagree about separators ("glm-5-3-flash" vs
// "glm-5.3-flash", "nemotron-3_5" vs "nemotron-3.5"), so both sides are
// compared with separators stripped.
export function normalizeModelKey(id) {
  return String(id || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
