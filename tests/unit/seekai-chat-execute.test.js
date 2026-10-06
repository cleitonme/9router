// SeekAI chat dispatch through the shared OpenAI-compatible adapter.
// The network layer is mocked — no real key, no live calls.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
const { getExecutor } = await import("../../open-sse/executors/index.js");

const FAKE_KEY = "sk-seekai-test-fake-key";
const creds = { apiKey: FAKE_KEY };

function sseResponse(status = 200) {
  const body = 'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
  return {
    status,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "text/event-stream" : "") },
    text: async () => body,
  };
}

beforeEach(() => fetchMock.mockReset());

describe("SeekAI chat via DefaultExecutor", () => {
  it("resolves to the shared DefaultExecutor", () => {
    expect(getExecutor("seekai")).toBeInstanceOf(DefaultExecutor);
  });

  it("builds the SeekAI chat URL without duplicating /v1", () => {
    const ex = new DefaultExecutor("seekai");
    expect(ex.buildUrl("claude-sonnet-5", true)).toBe("https://seekai.cc/v1/chat/completions");
    expect(ex.buildUrl("claude-sonnet-5", false)).toBe("https://seekai.cc/v1/chat/completions");
  });

  it("sends the API key as a Bearer header and nowhere else", () => {
    const ex = new DefaultExecutor("seekai");
    const headers = ex.buildHeaders(creds, true, ex.buildUrl("m", true), "m", {});
    expect(headers["Authorization"]).toBe(`Bearer ${FAKE_KEY}`);
    const leaked = Object.entries(headers)
      .filter(([k]) => k !== "Authorization")
      .map(([, v]) => String(v))
      .join(" ");
    expect(leaked).not.toContain(FAKE_KEY);
  });

  it("forwards model id, messages and stream flag verbatim over SSE", async () => {
    const ex = new DefaultExecutor("seekai");
    fetchMock.mockResolvedValue(sseResponse(200));
    const out = await ex.execute({
      model: "claude-sonnet-5",
      body: { model: "claude-sonnet-5", messages: [{ role: "user", content: "ping" }], stream: true },
      stream: true,
      credentials: creds,
    });
    expect(out.url).toBe("https://seekai.cc/v1/chat/completions");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://seekai.cc/v1/chat/completions");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Authorization"]).toBe(`Bearer ${FAKE_KEY}`);
    const sent = JSON.parse(opts.body);
    expect(sent.model).toBe("claude-sonnet-5");
    expect(sent.stream).toBe(true);
    expect(sent.messages).toEqual([{ role: "user", content: "ping" }]);
    expect(out.response.status).toBe(200);
  });

  it("surfaces upstream auth errors without retrying blindly", async () => {
    const ex = new DefaultExecutor("seekai");
    fetchMock.mockResolvedValue({ status: 401, headers: { get: () => "" } });
    const out = await ex.execute({
      model: "claude-sonnet-5",
      body: { model: "claude-sonnet-5", messages: [{ role: "user", content: "ping" }] },
      stream: false,
      credentials: { apiKey: "sk-wrong" },
    });
    expect(out.response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
