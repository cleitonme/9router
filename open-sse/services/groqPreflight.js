/**
 * Groq TPM / 413 preflight guard.
 *
 * Groq free tier enforces ~8000 TPM on models like openai/gpt-oss-120b.
 * Requests carrying large history + system prompt + tools can exceed that
 * before the first upstream byte is sent. This module:
 *  - estimates request tokens (conservative, tokenizer-free, CJK-aware),
 *  - compacts history in-place on a copy (fail-open, JSON-safe),
 *  - decides whether Groq must be skipped for this request,
 *  - classifies Groq TPM errors,
 *  - holds a short org-level provider block (TPM is per-org, not per-key).
 */

// Fixed safe budget for ALL Groq models: margin below the ~8000 TPM free limit.
export const GROQ_SAFE_BUDGET = 6500;
// Org-level block TTL after a Groq TPM hit (retry-after/reset headers can extend it).
export const GROQ_BLOCK_TTL_MS = 60 * 1000;
// Per tool-result cap applied during compaction (~1500 tokens).
export const GROQ_TOOL_RESULT_MAX_CHARS = 6000;

const CJK_RE = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;

// In-memory org-level blocks: provider -> { until, reason }.
// TPM is per-organization, so a second API key of the same provider won't help.
const providerBlocks = new Map();

export function blockProvider(provider, ttlMs = GROQ_BLOCK_TTL_MS, reason = "") {
  if (!provider) return;
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : GROQ_BLOCK_TTL_MS;
  providerBlocks.set(String(provider).toLowerCase(), {
    until: Date.now() + ttl,
    reason: String(reason || "").slice(0, 200),
  });
}

export function isProviderBlocked(provider) {
  if (!provider) return null;
  const entry = providerBlocks.get(String(provider).toLowerCase());
  if (!entry) return null;
  if (entry.until <= Date.now()) {
    providerBlocks.delete(String(provider).toLowerCase());
    return null;
  }
  return entry;
}

export function blockGroq(reason = "groq_tpm_limit", ttlMs = GROQ_BLOCK_TTL_MS) {
  blockProvider("groq", ttlMs, reason);
}

export function isGroqBlocked() {
  return isProviderBlocked("groq");
}

function charsToTokens(len, cjkCount = 0) {
  const n = Math.max(0, len - cjkCount);
  return Math.ceil(cjkCount + n / 4);
}

function countCjk(text) {
  try {
    return (text.match(CJK_RE) || []).length;
  } catch {
    return 0;
  }
}

/**
 * Conservative token estimate covering system prompt, history, tool
 * messages, tool definitions and requested max output tokens.
 * Tokenizer-free: JSON size with CJK correction + max_tokens.
 * Fail-open: returns 0 when the body can't be serialized.
 */
export function estimateRequestTokens(body) {
  try {
    if (!body || typeof body !== "object") return 0;
    let json = "";
    try {
      json = JSON.stringify(body) || "";
    } catch {
      return 0;
    }
    const cjk = countCjk(json);
    let tokens = charsToTokens(json.length, cjk);
    const maxOut =
      body.max_tokens ??
      body.max_completion_tokens ??
      body.maxTokens ??
      0;
    const maxOutNum = typeof maxOut === "number" && Number.isFinite(maxOut) ? maxOut : 0;
    if (maxOutNum > 0) tokens += Math.ceil(maxOutNum);
    return tokens;
  } catch {
    return 0;
  }
}

function getMessagesKey(body) {
  if (!body || typeof body !== "object") return null;
  if (Array.isArray(body.messages)) return "messages";
  if (Array.isArray(body.input)) return "input";
  if (Array.isArray(body.contents)) return "contents";
  return null;
}

function isSystemRole(role) {
  return role === "system" || role === "developer";
}

function getRole(msg) {
  return msg?.role ?? msg?.type ?? "";
}

function extractTextLength(content) {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let sum = 0;
    for (const b of content) {
      if (!b) continue;
      if (typeof b === "string") sum += b.length;
      else if (typeof b?.text === "string") sum += b.text.length;
      else if (typeof b?.content === "string") sum += b.content.length;
      else if (typeof b?.output === "string") sum += b.output.length;
      else sum += 50;
    }
    return sum;
  }
  if (content && typeof content === "object") {
    try {
      return JSON.stringify(content).length;
    } catch {
      return 50;
    }
  }
  return 0;
}

function isToolResultMessage(msg) {
  if (!msg || typeof msg !== "object") return false;
  const role = getRole(msg);
  if (role === "tool" || role === "function") return true;
  if (msg.tool_result || msg.function_call_output) return true;
  if (Array.isArray(msg.content)) {
    return msg.content.some(
      (b) => b?.type === "tool_result" || b?.type === "function_call_output" || b?.type === "toolResult"
    );
  }
  return false;
}

/**
 * Truncate one message's tool-result payload to maxChars without breaking
 * JSON/structure: operates on structured fields, never slices a serialized
 * JSON string mid-token. Returns bytes removed.
 */
function truncateToolResultMessage(msg, maxChars) {
  if (!msg || typeof msg !== "object") return 0;
  let removed = 0;
  const truncStr = (s) => {
    if (typeof s !== "string" || s.length <= maxChars) return s;
    removed += s.length - maxChars;
    return s.slice(0, maxChars) + `\n…[truncated ${s.length - maxChars} chars]`;
  };

  try {
    if (typeof msg.content === "string") {
      msg.content = truncStr(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (!b || typeof b !== "object") continue;
        if (typeof b.text === "string") b.text = truncStr(b.text);
        if (typeof b.output === "string") b.output = truncStr(b.output);
        if (typeof b.content === "string") b.content = truncStr(b.content);
        // Nested tool_result content blocks: [{ type:'text', text }]
        if (Array.isArray(b.content)) {
          for (const inner of b.content) {
            if (inner && typeof inner?.text === "string") inner.text = truncStr(inner.text);
          }
        }
      }
    } else if (msg.content && typeof msg.content === "object") {
      const before = extractTextLength(msg.content);
      // Only truncate known string leaves; keep object shape intact.
      for (const k of ["text", "output", "content"]) {
        if (typeof msg.content[k] === "string") msg.content[k] = truncStr(msg.content[k]);
      }
      removed += Math.max(0, before - extractTextLength(msg.content));
    }
    if (typeof msg.output === "string") msg.output = truncStr(msg.output);
  } catch {
    // fail-open: leave message untouched on unexpected shapes
  }
  return removed;
}

/**
 * Compact a copy of the request body to fit `budget` tokens.
 * Policy: preserve system prompt + current (last) user message + newest
 * turns; drop oldest non-system messages first; shrink oversized tool
 * results with a per-message cap. Never duplicates the user message —
 * operates on a cloned array. Fail-open: any error returns the input clone.
 */
export function compactForGroq(inputBody, budget = GROQ_SAFE_BUDGET) {
  const stats = {
    estimatedBefore: 0,
    estimatedAfter: 0,
    removedMessages: 0,
    removedToolBytes: 0,
  };
  let body;
  try {
    body = Array.isArray(inputBody)
      ? [...inputBody]
      : { ...inputBody };
  } catch {
    return { body: inputBody, ...stats };
  }

  try {
    stats.estimatedBefore = estimateRequestTokens(body);
    if (!stats.estimatedBefore || stats.estimatedBefore <= budget) {
      stats.estimatedAfter = stats.estimatedBefore;
      return { body, ...stats };
    }

    const key = getMessagesKey(body);
    if (!key) {
      stats.estimatedAfter = stats.estimatedBefore;
      return { body, ...stats };
    }

    // Shallow-clone messages so callers never see mutation.
    const arr = body[key].map((m) => (m && typeof m === "object" ? { ...m } : m));

    // 1) Shrink oversized tool results first (keeps structure/JSON valid).
    for (const msg of arr) {
      if (!isToolResultMessage(msg)) continue;
      const before = extractTextLength(msg.content ?? msg.output);
      if (before > GROQ_TOOL_RESULT_MAX_CHARS) {
        stats.removedToolBytes += truncateToolResultMessage(msg, GROQ_TOOL_RESULT_MAX_CHARS);
      }
    }

    let estimated = estimateRequestTokens({ ...body, [key]: arr });
    if (estimated <= budget) {
      stats.estimatedAfter = estimated;
      return { body: { ...body, [key]: arr }, ...stats };
    }

    // 2) Drop oldest non-system messages first. Always keep:
    //    - every system/developer message,
    //    - the current (last) user message,
    //    - newest turns (drop from the front of the droppable window).
    let lastUserIdx = -1;
    for (let i = arr.length - 1; i >= 0; i--) {
      const role = getRole(arr[i]);
      if (role === "user" || arr[i]?.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) lastUserIdx = arr.length - 1;

    const systemMsgs = [];
    const systemIdx = new Set();
    arr.forEach((m, i) => {
      if (isSystemRole(getRole(m))) {
        systemMsgs.push(m);
        systemIdx.add(i);
      }
    });

    const currentMsg = arr[lastUserIdx];
    // Droppable = non-system, non-current, in original order (oldest first).
    const droppable = [];
    for (let i = 0; i < arr.length; i++) {
      if (systemIdx.has(i) || i === lastUserIdx) continue;
      droppable.push(arr[i]);
    }

    // Binary-search-free linear drop from oldest until under budget.
    // Re-estimating per drop is O(n²) stringify; drop in chunks instead:
    // remove oldest half first, then one-by-one only if still over.
    let kept = [...droppable];
    const rebuild = (keptMiddle) => {
      // Preserve original relative order: systems first (original order),
      // then kept middle, then current message last (unless current was
      // already among systems, e.g. degenerate bodies).
      const out = [...systemMsgs, ...keptMiddle];
      if (!systemIdx.has(lastUserIdx)) out.push(currentMsg);
      return out;
    };

    while (kept.length > 0) {
      const dropCount = estimated > budget * 1.5 ? Math.max(1, Math.floor(kept.length / 2)) : 1;
      const dropped = kept.splice(0, dropCount);
      stats.removedMessages += dropped.length;
      stats.removedToolBytes += dropped.reduce(
        (s, m) => s + (isToolResultMessage(m) ? extractTextLength(m.content ?? m.output) : 0),
        0
      );
      estimated = estimateRequestTokens({ ...body, [key]: rebuild(kept) });
      if (estimated <= budget) break;
      if (dropCount === 1 && kept.length === 0) break;
    }

    const finalArr = rebuild(kept);
    stats.estimatedAfter = estimated;
    return { body: { ...body, [key]: finalArr }, ...stats };
  } catch {
    // fail-open
    try {
      stats.estimatedAfter = estimateRequestTokens(body);
    } catch {
      stats.estimatedAfter = stats.estimatedBefore;
    }
    return { body, ...stats };
  }
}

/**
 * Classify a Groq TPM / context-limit failure.
 * Matches: status 413, status 429, code rate_limit_exceeded, or messages
 * containing `tokens per minute`, `tpm` or `request too large`.
 * `tpm` alone is broad, so outside 413/429 it only matches alongside a
 * token/rate/limit word to avoid false positives.
 */
export function isGroqTpmError(status, errorText, provider = "groq") {
  try {
    if (String(provider || "").toLowerCase() !== "groq") return false;
    const text = (() => {
      if (!errorText) return "";
      if (typeof errorText === "string") return errorText.toLowerCase();
      try {
        return JSON.stringify(errorText).toLowerCase();
      } catch {
        return String(errorText).toLowerCase();
      }
    })();
    if (status === 413) return true;
    const hasRateLimitCode = text.includes("rate_limit_exceeded") || text.includes("rate limit");
    const hasTpmPhrase =
      text.includes("tokens per minute") ||
      text.includes("request too large") ||
      text.includes("too many tokens") ||
      text.includes("context") && text.includes("too large");
    const hasTpmWord =
      /\btpm\b/.test(text) && (text.includes("token") || text.includes("rate") || text.includes("limit") || status === 429);
    if (status === 429) {
      if (!text) return true; // bare Groq 429 is a rate limit
      return hasRateLimitCode || hasTpmPhrase || hasTpmWord || text.includes("too many requests") || text.includes("quota") || text.includes("capacity") || text.includes("overloaded");
    }
    return hasRateLimitCode || hasTpmPhrase || hasTpmWord;
  } catch {
    return false;
  }
}

/** Parse Groq rate-limit reset hints into an epoch-ms cooldown expiry. */
export function parseGroqResetsAtMs(headers) {
  try {
    if (!headers) return null;
    const get = (name) => {
      try {
        if (typeof headers.get === "function") {
          const v = headers.get(name) ?? headers.get(name.toLowerCase());
          if (v != null) return String(v);
        }
      } catch { /* ignore */ }
      if (typeof headers === "object") {
        for (const k of [name, name.toLowerCase(), name.toUpperCase()]) {
          if (headers[k] != null) return String(headers[k]);
        }
      }
      return null;
    };
    // retry-after is authoritative (seconds).
    const retryAfter = get("retry-after");
    if (retryAfter != null && retryAfter !== "") {
      const secs = Number.parseFloat(retryAfter);
      if (Number.isFinite(secs) && secs >= 0) return Date.now() + Math.ceil(secs * 1000);
      const asDate = Date.parse(retryAfter);
      if (Number.isFinite(asDate) && asDate > Date.now()) return asDate;
    }
    // Groq exposes x-ratelimit-reset-requests / -tokens (Go durations like "2m59s" or epoch seconds).
    for (const name of ["x-ratelimit-reset-tokens", "x-ratelimit-reset-requests", "x-ratelimit-reset"]) {
      const raw = get(name);
      if (!raw) continue;
      const asNum = Number.parseFloat(raw);
      if (Number.isFinite(asNum) && asNum > 0) {
        // Heuristic: large numbers are epoch seconds, small ones are delta seconds.
        if (asNum > 1e9) {
          const ms = asNum * 1000;
          if (ms > Date.now()) return ms;
        } else {
          return Date.now() + Math.ceil(asNum * 1000);
        }
      }
      const goDur = parseGoDurationMs(raw);
      if (goDur != null) return Date.now() + goDur;
      const asDate = Date.parse(raw);
      if (Number.isFinite(asDate) && asDate > Date.now()) return asDate;
    }
    return null;
  } catch {
    return null;
  }
}

/** Parse Go-style durations ("2m59.56s", "1h2m3s") to milliseconds. */
export function parseGoDurationMs(raw) {
  try {
    const s = String(raw || "").trim();
    if (!s || !/[hms]/.test(s)) return null;
    const re = /(\d+(?:\.\d+)?)(h|m(?!s)|s|ms)/g;
    let total = 0;
    let matched = false;
    let m;
    while ((m = re.exec(s)) !== null) {
      matched = true;
      const val = Number.parseFloat(m[1]);
      if (!Number.isFinite(val)) return null;
      if (m[2] === "h") total += val * 3600 * 1000;
      else if (m[2] === "m") total += val * 60 * 1000;
      else if (m[2] === "s") total += val * 1000;
      else if (m[2] === "ms") total += val;
    }
    return matched ? total : null;
  } catch {
    return null;
  }
}
