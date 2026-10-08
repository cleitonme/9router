// Empty-upstream gate: a 200 with zero content/reasoning/tool chunks must be
// detected as empty (→ combo falls back to the next model) instead of being
// forwarded as a clean [DONE] that breaks the client with
// `text(...) must not be null`. Captured live: kilo-gateway/kilo-auto/free
// logged "succeeded · IN 0 · OUT 0" and models 3/5..5/5 were never tried.
import { describe, it, expect } from "vitest";
import {
  EMPTY_UPSTREAM_MARKER,
  openAIChunkHasContent,
  claudeChunkHasContent,
  bufferedTextHasContent,
  isEmptyCompletionBody,
  gateUpstreamStream,
} from "../../open-sse/utils/streamGate.js";
import { classifyError } from "../../open-sse/utils/classifyError.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

function sseResponse(lines) {
  const text = lines.join("\n");
  return new Response(text, { headers: { "Content-Type": "text/event-stream" } });
}

const DONE = "data: [DONE]";

describe("openAIChunkHasContent (strict)", () => {
  it("accepts text content", () => {
    expect(openAIChunkHasContent({ choices: [{ delta: { content: "hi" } }] })).toBe(true);
  });
  it("accepts reasoning and tool_calls as content", () => {
    expect(openAIChunkHasContent({ choices: [{ delta: { reasoning_content: "think" } }] })).toBe(true);
    expect(openAIChunkHasContent({ choices: [{ delta: { tool_calls: [{ id: "1" }] } }] })).toBe(true);
  });
  it("rejects role-only / usage-only / finish-only chunks", () => {
    expect(openAIChunkHasContent({ choices: [{ delta: { role: "assistant" } }] })).toBe(false);
    expect(openAIChunkHasContent({ choices: [{ delta: {}, finish_reason: "stop" }], usage: {} })).toBe(false);
    expect(openAIChunkHasContent({ choices: [{ delta: {} }] })).toBe(false);
  });
  it("fails open on error chunks", () => {
    expect(openAIChunkHasContent({ error: { message: "boom" } })).toBe(true);
  });
});

describe("claudeChunkHasContent (strict)", () => {
  it("accepts text deltas and tool_use starts", () => {
    expect(claudeChunkHasContent({ type: "content_block_delta", delta: { text: "hi" } })).toBe(true);
    expect(claudeChunkHasContent({ type: "content_block_start", content_block: { type: "tool_use" } })).toBe(true);
  });
  it("rejects empty deltas and lifecycle events", () => {
    expect(claudeChunkHasContent({ type: "content_block_delta", delta: { text: "" } })).toBe(false);
    expect(claudeChunkHasContent({ type: "message_start", message: { content: [] } })).toBe(false);
    expect(claudeChunkHasContent({ type: "message_stop" })).toBe(false);
  });
});

describe("bufferedTextHasContent", () => {
  it("detects the reported kilo case: bare [DONE] is empty", () => {
    expect(bufferedTextHasContent(`${DONE}\n\n`, "openai")).toBe(false);
    expect(bufferedTextHasContent("", "openai")).toBe(false);
  });
  it("detects role+finish-only streams as empty", () => {
    const s = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":0}}',
      DONE,
    ].join("\n");
    expect(bufferedTextHasContent(s, "openai")).toBe(false);
  });
  it("detects real content", () => {
    const s = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      'data: {"choices":[{"delta":{"content":"hello"}}]}',
      DONE,
    ].join("\n");
    expect(bufferedTextHasContent(s, "openai")).toBe(true);
  });
  it("is fail-open for unknown formats", () => {
    expect(bufferedTextHasContent('data: {"something":1}\n', "antigravity")).toBe(true);
    expect(bufferedTextHasContent(`${DONE}\n`, "openai-responses")).toBe(false);
  });
});

describe("isEmptyCompletionBody", () => {
  it("flags empty OpenAI completions", () => {
    expect(isEmptyCompletionBody({ choices: [{ message: { content: "" }, finish_reason: "stop" }] })).toBe(true);
    expect(isEmptyCompletionBody({ choices: [{ message: { content: null }, finish_reason: "stop" }] })).toBe(true);
  });
  it("keeps tool_calls and reasoning as non-empty", () => {
    expect(isEmptyCompletionBody({ choices: [{ message: { content: null, tool_calls: [{ id: "1" }] }, finish_reason: "tool_calls" }] })).toBe(false);
    expect(isEmptyCompletionBody({ choices: [{ message: { content: "", reasoning_content: "r" }, finish_reason: "stop" }] })).toBe(false);
  });
  it("flags empty Claude messages and Responses outputs", () => {
    expect(isEmptyCompletionBody({ type: "message", content: [] })).toBe(true);
    expect(isEmptyCompletionBody({ object: "response", output: [] })).toBe(true);
  });
});

describe("gateUpstreamStream", () => {
  it("returns empty for a content-less 200 stream", async () => {
    const res = sseResponse(['data: {"choices":[{"delta":{"role":"assistant"}}]}', DONE, ""]);
    const gate = await gateUpstreamStream(res, { timeoutMs: 2000, formatHint: "openai" });
    expect(gate.empty).toBe(true);
  });
  it("replays buffered + live bytes untouched for non-empty streams", async () => {
    const lines = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      'data: {"choices":[{"delta":{"content":"hello"}}]}',
      DONE,
      "",
    ];
    const gate = await gateUpstreamStream(sseResponse(lines), { timeoutMs: 2000, formatHint: "openai" });
    expect(gate.empty).toBe(false);
    expect(await gate.response.text()).toBe(lines.join("\n"));
  });
  it("treats null body as empty", async () => {
    const gate = await gateUpstreamStream(new Response(null, { status: 200 }), { timeoutMs: 500 });
    expect(gate.empty).toBe(true);
  });
  it("fails open on timeout (never breaks slow models)", async () => {
    const stream = new ReadableStream({ start(c) { /* never emits, never closes */ } });
    const gate = await gateUpstreamStream(new Response(stream), { timeoutMs: 50, formatHint: "openai" });
    expect(gate.empty).toBe(false);
    expect(gate.timedOut).toBe(true);
    await gate.response.body.cancel();
  });
});

describe("empty_response classification drives fallback", () => {
  const msg = `[${EMPTY_UPSTREAM_MARKER}] kgw/kilo-auto/free returned 200 with an empty stream`;
  it("classifies the marker as empty_response (model scope)", () => {
    const c = classifyError({ status: 502, bodyText: msg });
    expect(c.type).toBe("empty_response");
    expect(c.scope).toBe("model");
  });
  it("checkFallbackError advances the combo (short transient cooldown)", () => {
    const r = checkFallbackError(502, msg, 0, null, {});
    expect(r.shouldFallback).toBe(true);
    expect(r.cooldownMs).toBeGreaterThan(0);
    // Never a long account/quota lock for an empty model turn.
    expect(r.cooldownMs).toBeLessThanOrEqual(30 * 1000);
  });
});
