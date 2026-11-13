// Issue #2229: a model answers 200 with a body that carries no content
// (`{"text":""}` and friends). That is not success; the combo must advance, and
// must report an error rather than the empty body when no member produces content.
import { describe, expect, it, vi } from "vitest";
import { handleComboChat, isZeroContentResponse } from "../../open-sse/services/combo.js";

describe("isZeroContentResponse", () => {
  it("empty and unknown shapes are zero content", () => {
    for (const body of [null, undefined, "", 0, {}, [], { text: "" }, { text: " " }]) {
      expect(isZeroContentResponse(body)).toBe(true);
    }
  });

  it("the issue's literal body is zero content", () => {
    expect(isZeroContentResponse({ text: "" })).toBe(true);
  });

  it("bare text with content is content", () => {
    expect(isZeroContentResponse({ text: "hello" })).toBe(false);
  });

  it("OpenAI chat: text, tool_calls and reasoning each count as content", () => {
    const wrap = (message, finish = "stop") => ({ choices: [{ index: 0, message, finish_reason: finish }] });
    expect(isZeroContentResponse(wrap({ role: "assistant", content: "hi" }))).toBe(false);
    expect(isZeroContentResponse(wrap({ role: "assistant", content: "" }))).toBe(true);
    expect(isZeroContentResponse(wrap({ role: "assistant", content: null }))).toBe(true);
    expect(isZeroContentResponse(wrap({ role: "assistant", content: "", tool_calls: [{ id: "1" }] }))).toBe(false);
    expect(isZeroContentResponse(wrap({ role: "assistant", content: "", reasoning_content: "thinking" }))).toBe(false);
    expect(isZeroContentResponse({ choices: [] })).toBe(true);
  });

  it("Anthropic: text and tool_use are content; thinking-only is not", () => {
    expect(isZeroContentResponse({ content: [{ type: "text", text: "hi" }] })).toBe(false);
    expect(isZeroContentResponse({ content: [{ type: "text", text: " " }] })).toBe(true);
    expect(isZeroContentResponse({ content: [{ type: "tool_use", name: "f", input: {} }] })).toBe(false);
    expect(isZeroContentResponse({ content: [{ type: "thinking", thinking: "hmm" }] })).toBe(false);
  });

  it("Gemini native: text and functionCall are content; empty parts are not", () => {
    expect(isZeroContentResponse({ candidates: [{ content: { parts: [{ text: "hi" }] } }] })).toBe(false);
    expect(isZeroContentResponse({ candidates: [{ content: { parts: [{ text: "" }] } }] })).toBe(true);
    expect(isZeroContentResponse({ candidates: [{ content: { parts: [{ functionCall: { name: "f" } }] } }] })).toBe(false);
  });

  it("Responses: output_text and function_call items are content", () => {
    expect(isZeroContentResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] })).toBe(false);
    expect(isZeroContentResponse({ output: [{ type: "message", content: [{ type: "output_text", text: "" }] }] })).toBe(true);
    expect(isZeroContentResponse({ output: [{ type: "function_call", name: "f", arguments: "{}" }] })).toBe(false);
    expect(isZeroContentResponse({ output: [{ type: "reasoning", summary: [] }] })).toBe(true);
    expect(isZeroContentResponse({ output: [] })).toBe(true);
  });
});

// Non-streaming combo seats (application/json) get the same failover.
describe("combo fall-through for JSON (non-stream) members", () => {
  const LOG = { line: vi.fn(), errorLine: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const jsonRes = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

  async function combo(bodies) {
    const tried = [];
    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }], stream: false },
      models: bodies.map((_, i) => `openai/m${i}`),
      handleSingleModel: async (_b, m) => { tried.push(m); return jsonRes(bodies[Number(m.slice(-1))]); },
      log: LOG,
      comboName: `j-${Math.random()}`,
      comboStrategy: "fallback",
    });
    const text = await res.text();
    return { tried, status: res.status, body: JSON.parse(text) };
  }

  it('`{"text":""}` first member falls through to a good one', async () => {
    const { tried, body } = await combo([{ text: "" }, { choices: [{ message: { content: "from-m1" }, finish_reason: "stop" }] }]);
    expect(tried).toEqual(["openai/m0", "openai/m1"]);
    expect(body.choices[0].message.content).toBe("from-m1");
  });

  it('empty chat body `{choices:[{message:{content:""}}]}` falls through', async () => {
    const { tried } = await combo([{ choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] }, { text: "from-m1" }]);
    expect(tried).toEqual(["openai/m0", "openai/m1"]);
  });

  it("a good first member is committed", async () => {
    const { tried, body } = await combo([{ text: "from-m0" }, { text: "from-m1" }]);
    expect(tried).toEqual(["openai/m0"]);
    expect(body.text).toBe("from-m0");
  });

  it("all members empty → 502 with an error body, never a hollow 200", async () => {
    const { tried, status, body } = await combo([{ text: "" }, { choices: [{ message: { content: "" }, finish_reason: "stop" }] }]);
    expect(tried).toEqual(["openai/m0", "openai/m1"]);
    expect(status).toBe(502);
    expect(body.error.message).toContain("Zero usable content");
  });
});
