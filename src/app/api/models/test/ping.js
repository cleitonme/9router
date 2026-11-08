import { getApiKeys } from "@/lib/localDb";
import { resolveProviderId } from "@/shared/constants/providers.js";
import { unwrapClineEnvelope } from "open-sse/shared/clineEnvelope.js";
import { MODEL_PROBE_TIMEOUT_MS } from "open-sse/config/runtimeConfig.js";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { getConsistentMachineId } from "@/shared/utils/machineId";

const CLI_TOKEN_SALT = "9r-cli-auth";

function createSilentWavFile() {
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const durationMs = 250;
  const sampleCount = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
  const dataSize = sampleCount * channels * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  return new Blob([buffer], { type: "audio/wav" });
}

async function getInternalHeaders() {
  let apiKey = null;
  try {
    const keys = await getApiKeys();
    apiKey = keys.find((k) => k.isActive !== false)?.key || null;
  } catch {}

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  headers["x-9r-cli-token"] = await getConsistentMachineId(CLI_TOKEN_SALT);
  return headers;
}

export async function pingModelByKind(model, kind, baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`) {
  const headers = await getInternalHeaders();
  const start = Date.now();

  if (kind === "embedding") {
    const res = await fetch(`${baseUrl}/api/v1/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input: "test" }),
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.error || rawText;
      return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
    }
    const hasEmbedding = Array.isArray(parsed?.data) && parsed.data.length > 0 && Array.isArray(parsed.data[0]?.embedding);
    if (!hasEmbedding) {
      return { ok: false, latencyMs, status: res.status, error: "Provider returned no embedding data" };
    }
    return { ok: true, latencyMs, error: null, status: res.status };
  }

  if (kind === "image") {
    const res = await fetch(`${baseUrl}/api/v1/images/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, prompt: "test" }),
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
      return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
    }

    const hasImages = Array.isArray(parsed?.data) && parsed.data.length > 0;
    if (!hasImages) {
      return { ok: false, latencyMs, status: res.status, error: "Provider returned no image data for this model" };
    }
    return { ok: true, latencyMs, error: null, status: res.status };
  }

  if (kind === "stt") {
    const form = new FormData();
    const sampleAudio = createSilentWavFile();
    form.append("file", sampleAudio, "test.wav");
    form.append("model", model);

    const res = await fetch(`${baseUrl}/api/v1/audio/transcriptions`, {
      method: "POST",
      headers: Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== "content-type")),
      body: form,
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
      return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
    }

    const text = typeof parsed?.text === "string" ? parsed.text : "";
    if (!text.trim()) {
      return { ok: false, latencyMs, status: res.status, error: "Provider returned no transcription text for this model" };
    }
    return { ok: true, latencyMs, error: null, status: res.status };
  }

  if (kind === "systemone") {
    const res = await fetch(`${baseUrl}/api/v1/systemone`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        state: "Customer: I was charged twice for my order this morning.",
        questions: {
          probe: { type: "noul", instructions: "Is the customer reporting a billing problem?" },
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
      return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
    }

    const hasAnswers = parsed?.answers && typeof parsed.answers === "object" && Object.keys(parsed.answers).length > 0;
    if (!hasAnswers) {
      return { ok: false, latencyMs, status: res.status, error: "Provider returned no answers for this model" };
    }
    return { ok: true, latencyMs, error: null, status: res.status };
  }

  // Probe chat models with a streamed request and stop at the first token.
  // A full non-streamed answer makes slow reasoning models look dead: they burn
  // the whole budget on chain-of-thought before returning anything. Any choice
  // frame (even role-only or reasoning-only) proves the route works, so we
  // cancel the stream immediately instead of waiting for the answer.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, MODEL_PROBE_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        // Sound budget for providers that ignore `stream` and return a whole
        // answer. The stream is cancelled at the first token anyway.
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: controller.signal,
    });

    const providerId = resolveProviderId(String(model).split("/")[0]);

    if (!res.ok) {
      const rawText = await res.text().catch(() => "");
      let parsed = null;
      try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}
      parsed = unwrapClineEnvelope(parsed, providerId);
      const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 500)}` : ""}`,
        status: res.status,
      };
    }

    // Some providers/tests return a whole JSON body even when stream is asked.
    if (!res.body) {
      const rawText = await res.text().catch(() => "");
      let parsed = null;
      try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}
      parsed = unwrapClineEnvelope(parsed, providerId);
      return evaluateParsedChat(parsed, res.status, start);
    }

    const unwrap = (json) => unwrapClineEnvelope(json, providerId);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let outcome = null;

    while (!outcome) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 256 * 1024) break;
      outcome = scanProbeStream(buffer, unwrap);
    }

    if (!outcome) outcome = scanProbeStream(`${buffer}\n`, unwrap);

    try { await reader.cancel(); } catch { /* upstream may already be closed */ }

    if (outcome?.ok) {
      return { ok: true, latencyMs: Date.now() - start, error: null, status: res.status };
    }
    if (outcome?.error) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        status: res.status,
        error: String(outcome.error).slice(0, 240),
      };
    }
    return {
      ok: false,
      latencyMs: Date.now() - start,
      status: res.status,
      error: "Provider returned no completion data for this model",
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      status: 0,
      error: timedOut
        ? `Probe timed out after ${MODEL_PROBE_TIMEOUT_MS}ms waiting for the first token`
        : String(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Evaluate a whole (non-streamed) chat body. Kept for providers that ignore
// `stream: true`, and mirrors the reasoning-model soft-pass from issue #3010.
function evaluateParsedChat(parsed, status, start) {
  const latencyMs = Date.now() - start;

  const providerStatus = parsed?.status;
  const providerMsg = parsed?.msg || parsed?.message;
  const hasProviderErrorStatus = providerStatus !== undefined
    && providerStatus !== null
    && String(providerStatus) !== "200"
    && String(providerStatus) !== "0";
  if (hasProviderErrorStatus && providerMsg) {
    return {
      ok: false,
      latencyMs,
      status,
      error: `Provider status ${providerStatus}: ${String(providerMsg).slice(0, 240)}`,
    };
  }

  if (parsed?.error) {
    const providerError = parsed?.error?.message || parsed?.error || "Provider returned an error";
    return {
      ok: false,
      latencyMs,
      status,
      error: String(providerError).slice(0, 240),
    };
  }

  const hasChoices = Array.isArray(parsed?.choices) && parsed.choices.length > 0;
  const firstChoice = parsed?.choices?.[0] || {};
  const hasReasoning =
    firstChoice.message?.reasoning ||
    firstChoice.message?.reasoning_content ||
    firstChoice.message?.thinking ||
    firstChoice.message?.thinking_content;
  const contentEmpty = !String(firstChoice.message?.content || "").trim();
  if (hasChoices && firstChoice.finish_reason === "length" && contentEmpty && hasReasoning) {
    return {
      ok: true,
      latencyMs,
      status,
      error: null,
      note: "reasoning-only response (length-limited)",
    };
  }

  if (!hasChoices) {
    return {
      ok: false,
      latencyMs,
      status,
      error: "Provider returned no completion choices for this model",
    };
  }

  return { ok: true, latencyMs, status, error: null };
}

// Parse complete SSE/JSON lines from a probe buffer. Returns the first decisive
// signal: a choice frame (route is alive) or an error frame (route is broken).
// Incomplete trailing lines are ignored until the next chunk completes them.
function scanProbeStream(buffer, unwrap) {
  const lines = String(buffer || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let json = null;
    if (trimmed.startsWith("data:")) {
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try { json = JSON.parse(payload); } catch { continue; }
    } else if (trimmed.startsWith("{")) {
      try { json = JSON.parse(trimmed); } catch { continue; }
    } else {
      continue;
    }

    if (json && unwrap) json = unwrap(json);

    if (json?.error) {
      const error = json.error?.message || json.error?.msg || json.error;
      return { error };
    }
    if (Array.isArray(json?.choices) && json.choices.length > 0) {
      return { ok: true };
    }
  }
  return null;
}
