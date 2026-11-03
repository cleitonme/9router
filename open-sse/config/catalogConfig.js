// Live provider catalog shared config.
// Provider endpoints live in each registry entry (`catalog`), not here.
// This file only holds the heuristics used to keep non-chat models out of the
// LLM catalogue and the refresh/TTL policy shared by the service + scheduler.

// Substring signals (lowercased before match) for models that are NOT served
// through /v1/chat/completions. Kept config-driven so a new family is a
// one-line change instead of a condition inside the service.
export const NON_CHAT_MODEL_PATTERNS = [
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
