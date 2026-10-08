/**
 * Empty-upstream gate for streaming responses.
 *
 * Problem: handleComboChat treats any HTTP 2xx as success, and the streaming
 * path commits to `success:true` as soon as upstream headers arrive — before
 * any token flows. An upstream that answers 200 with an empty stream (zero
 * content chunks, `OUT 0`) was forwarded as a clean `[DONE]`, and the client
 * broke with `text(...) must not be null` while models 3/5..5/5 were never
 * tried.
 *
 * Fix: buffer the upstream body until the first chunk carrying real content
 * (text, reasoning, tool calls — or an explicit error chunk, fail-open) or
 * the terminal. Empty at EOF → `{ empty: true }` so the caller returns a
 * 502 error result and the combo/account fallback advances. Non-empty →
 * `{ empty: false, response }` where `response` replays the buffered bytes
 * followed by the live remainder, so normal streams keep flowing with only a
 * first-token delay.
 *
 * Pure + dependency-free (no config/logger imports) so it stays unit-testable.
 * Timeout is injected by the caller (see EMPTY_STREAM_GATE_TIMEOUT_MS).
 */

export const EMPTY_UPSTREAM_MARKER = "empty_upstream_response";

export const DEFAULT_GATE_TIMEOUT_MS = 30 * 1000;

/**
 * Strict "does this OpenAI-format chunk carry answer content?" check.
 * Deliberately stricter than hasValuableContent: role-only, usage-only and
 * finish_reason-only chunks do NOT count — a stream made of only those is
 * exactly the empty success we must fall back from. tool_calls and
 * reasoning_content count as content (legitimate non-text answers).
 */
export function openAIChunkHasContent(chunk) {
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return false;
  // Fail-open: an explicit error payload is handled by the normal error path.
  if (chunk.error) return true;
  const choice = chunk.choices?.[0];
  if (!choice || typeof choice !== "object") return false;
  const delta = choice.delta || choice.message || {};
  if (typeof delta.content === "string" && delta.content.length > 0) return true;
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
  if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) return true;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
  return false;
}

/**
 * Strict content check for Claude-format SSE events.
 */
export function claudeChunkHasContent(chunk) {
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) return false;
  if (chunk.error) return true;
  if (chunk.type === "content_block_delta") {
    const d = chunk.delta || {};
    if (typeof d.text === "string" && d.text.length > 0) return true;
    if (typeof d.thinking === "string" && d.thinking.length > 0) return true;
    if (typeof d.partial_json === "string" && d.partial_json.length > 0) return true;
    return false;
  }
  // A tool_use block start means a tool call answer is coming — not empty.
  if (chunk.type === "content_block_start" && chunk.content_block?.type === "tool_use") return true;
  return false;
}

function tryParseJsonObject(text) {
  const t = String(text || "").trim();
  if (!t || !t.startsWith("{")) return null;
  try {
    const j = JSON.parse(t);
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

/**
 * Scan buffered SSE text for any content chunk.
 * @param {string} text - raw buffered upstream bytes decoded as text
 * @param {string} [formatHint] - "openai" | "claude" | other (fail-open: any
 *   non-[DONE] data chunk counts as content for unknown formats)
 */
export function bufferedTextHasContent(text, formatHint) {
  if (!text) return false;
  const hint = String(formatHint || "").toLowerCase();
  // Strict emptiness scan only applies to OpenAI chat and Claude wire shapes.
  // Every other upstream format (Responses SSE, Gemini, binary envelopes, …)
  // is fail-open: any structured data chunk counts as content so the gate can
  // never invent an empty success outside the shapes it understands.
  const strictOpenAI = hint === "openai";
  const strictClaude = !strictOpenAI && hint.includes("claude");
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const chunk = tryParseJsonObject(payload);
    // Non-JSON data lines: fail-open, treat as content (don't invent emptiness).
    if (!chunk) return true;
    if (chunk.error || chunk.done) {
      if (chunk.error) return true;
      continue;
    }
    if (strictClaude) {
      if (claudeChunkHasContent(chunk)) return true;
    } else if (strictOpenAI) {
      if (openAIChunkHasContent(chunk)) return true;
      // role-only / usage-only / finish-only chunk — keep waiting.
    } else {
      // Unknown provider format carrying structured data — fail-open.
      return true;
    }
  }
  return false;
}

/**
 * A translated completion body (non-streaming path) is empty when it carries
 * no assistant text, no tool calls and no reasoning — across OpenAI, Claude
 * message and Responses shapes.
 */
export function isEmptyCompletionBody(body) {
  if (!body || typeof body !== "object") return true;
  // OpenAI chat completion
  const choice = body.choices?.[0];
  if (choice) {
    const msg = choice.message || choice.delta || {};
    if (typeof msg.content === "string" && msg.content.length > 0) return false;
    if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > 0) return false;
    if (typeof msg.reasoning === "string" && msg.reasoning.length > 0) return false;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return false;
    return true;
  }
  // Claude message
  if (body.type === "message" && Array.isArray(body.content)) {
    for (const block of body.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) return false;
      if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) return false;
      if (block.type === "tool_use") return false;
    }
    return true;
  }
  // OpenAI Responses API
  if (body.object === "response" && Array.isArray(body.output)) {
    for (const item of body.output) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (typeof c?.text === "string" && c.text.length > 0) return false;
        }
      }
      if (item.type === "function_call" || item.type === "custom_tool_call") return false;
      if (item.type === "reasoning" && Array.isArray(item.summary) && item.summary.length > 0) return false;
    }
    return true;
  }
  // Gemini/Antigravity non-stream shape: parts with text
  const parts = body.response?.candidates?.[0]?.content?.parts || body.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    for (const p of parts) {
      if (typeof p?.text === "string" && p.text.length > 0) return false;
      if (p?.functionCall) return false;
    }
    return true;
  }
  // Unrecognized shape — fail-open, never invent emptiness.
  return false;
}

function replayResponse(originalResponse, bufferedChunks, reader, pendingRead = null) {
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for (const c of bufferedChunks) controller.enqueue(c);
        // A read that was already pending when the gate timed out owns the
        // next chunk — await it here (in stream order) instead of dropping it.
        if (pendingRead) {
          try {
            const { done, value } = await pendingRead;
            if (!done && value) controller.enqueue(value);
          } catch { /* reader broken — fall through to live reads */ }
        }
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        }
        controller.close();
      } catch (e) {
        try { controller.error(e); } catch { /* already closed */ }
      }
    },
    cancel() {
      try { reader?.cancel?.(); } catch { /* best-effort */ }
    },
  });
  return new Response(stream, {
    status: originalResponse.status,
    statusText: originalResponse.statusText,
    headers: originalResponse.headers,
  });
}

/**
 * Buffer the upstream stream until first real content, terminal, or timeout.
 *
 * @param {Response} providerResponse - upstream response (must be ok)
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - gate timeout; expiry fails OPEN
 *   (proceeds with the stream as non-empty) so slow models never break
 * @param {string} [options.formatHint] - "openai" | "claude" for strict scan
 * @param {AbortSignal} [options.signal] - client disconnect aborts the gate
 * @returns {Promise<{ empty: boolean, response?: Response, timedOut?: boolean }>}
 */
export async function gateUpstreamStream(providerResponse, { timeoutMs = DEFAULT_GATE_TIMEOUT_MS, formatHint = "openai", signal = null } = {}) {
  const body = providerResponse?.body;
  if (!body || typeof body.getReader !== "function") {
    return { empty: true };
  }
  const reader = body.getReader();
  const buffered = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let seenText = "";
  let timedOut = false;
  let timer = null;
  try {
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => { timedOut = true; resolve({ timeout: true }); }, timeoutMs);
    });
    for (;;) {
      if (signal?.aborted) {
        try { reader.cancel(); } catch { /* ignore */ }
        return { empty: false, response: replayResponse(providerResponse, buffered, null), timedOut };
      }
      const readPromise = reader.read();
      const raced = await Promise.race([readPromise.then((r) => ({ read: r })), timeoutPromise]);
      if (raced.timeout || timedOut) {
        // Fail-open: hand back everything buffered + the live remainder.
        // The still-pending read owns the next chunk — thread it into the
        // replay stream (in order) so no byte is dropped and nothing hangs.
        const nonEmpty = bufferedTextHasContent(seenText, formatHint);
        return { empty: false, response: replayResponse(providerResponse, buffered, reader, readPromise), timedOut: true, hasContent: nonEmpty };
      }
      const { done, value } = raced.read;
      if (done) break;
      if (value) {
        buffered.push(value);
        try { seenText += decoder.decode(value, { stream: true }); } catch { /* keep raw bytes anyway */ }
        if (bufferedTextHasContent(seenText, formatHint)) {
          return { empty: false, response: replayResponse(providerResponse, buffered, reader) };
        }
      }
    }
    try { seenText += decoder.decode(); } catch { /* ignore */ }
    if (bufferedTextHasContent(seenText, formatHint)) {
      return { empty: false, response: replayResponse(providerResponse, buffered, null) };
    }
    try { reader.releaseLock(); } catch { /* ignore */ }
    return { empty: true };
  } catch {
    // Read error mid-gate: fail-open, replay whatever arrived.
    try { return { empty: false, response: replayResponse(providerResponse, buffered, reader), timedOut }; }
    catch { return { empty: false, timedOut }; }
  } finally {
    if (timer) clearTimeout(timer);
  }
}
