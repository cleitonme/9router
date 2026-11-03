import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { createSessionMock, loadRuntimeDepMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  loadRuntimeDepMock: vi.fn(),
}));

vi.mock("../../open-sse/services/lazyRuntime.js", () => ({
  loadRuntimeDep: loadRuntimeDepMock,
}));

describe("opencodeTlsClient", () => {
  beforeEach(async () => {
    vi.resetModules();
    createSessionMock.mockReset();
    loadRuntimeDepMock.mockReset();
    loadRuntimeDepMock.mockResolvedValue({ createSession: createSessionMock });
  });

  afterEach(() => {
    process.env.OPENCODE_TLS_FRESH = process.env.OPENCODE_TLS_FRESH || "";
    vi.resetModules();
  });

  it("uses the cipher list the upstream accepts and sends ALPN-negotiated requests", async () => {
    const response = new Response("data: ok\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const fetchMock = vi.fn().mockResolvedValue(response);
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch, __test__ } = await import("../../open-sse/services/opencodeTlsClient.js");
    const result = await opencodeTlsFetch("https://opencode.ai/inference/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    const options = createSessionMock.mock.calls[0][0];
    expect(options.emulation.tlsOptions.cipherList).toBe(__test__.OPENCODE_CIPHER_LIST);
    expect(__test__.OPENCODE_CIPHER_LIST.split(":")).toHaveLength(17);
    expect(__test__.OPENCODE_CIPHER_LIST.startsWith("TLS_AES_128_GCM_SHA256")).toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://opencode.ai/inference/v1/chat/completions",
      expect.objectContaining({ method: "POST", body: "{}" })
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("text/event-stream");
  });

  it("surfaces an actionable error when wreq-js is unavailable", async () => {
    loadRuntimeDepMock.mockRejectedValue(new Error("MODULE_NOT_FOUND"));

    const { opencodeTlsFetch, OpencodeTlsUnavailableError } = await import(
      "../../open-sse/services/opencodeTlsClient.js"
    );

    await expect(opencodeTlsFetch("https://opencode.ai/a", {})).rejects.toBeInstanceOf(
      OpencodeTlsUnavailableError
    );
  });

  it("forwards the abort signal so a cancelled stream stops upstream", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    const controller = new AbortController();
    await opencodeTlsFetch("https://opencode.ai/a", {}, { signal: controller.signal });

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("respects proxyUrl parameter for proxy-aware connections", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    await opencodeTlsFetch("https://opencode.ai/a", {}, { proxyUrl: "http://127.0.0.1:8080" });

    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        proxy: "http://127.0.0.1:8080",
      })
    );
  });

  it("pooled mode reuses sessions when OPENCODE_TLS_FRESH=0", async () => {
    process.env.OPENCODE_TLS_FRESH = "0";
    vi.resetModules();

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");

    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    await opencodeTlsFetch("https://opencode.ai/a", {});
    await opencodeTlsFetch("https://opencode.ai/b", {});

    expect(createSessionMock).toHaveBeenCalledTimes(1);
  });

  it("closes TLS session on stream completion in fresh mode", async () => {
    process.env.OPENCODE_TLS_FRESH = "1";
    vi.resetModules();

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");

    const closeMock = vi.fn();
    const response = new Response(new ReadableStream({
      async pull(controller) {
        controller.enqueue(new TextEncoder().encode("data: ok\n\n"));
        controller.close();
      },
    }), { status: 200 });

    const fetchMock = vi.fn().mockResolvedValue(response);
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: closeMock });

    const result = await opencodeTlsFetch("https://opencode.ai/a", {});
    await result.text();

    expect(closeMock).toHaveBeenCalled();
  });

  it("handles connection cleanup gracefully", async () => {
    process.env.OPENCODE_TLS_FRESH = "0";
    vi.resetModules();

    const { resetOpencodeTlsSession } = await import("../../open-sse/services/opencodeTlsClient.js");

    const closeMock = vi.fn();
    createSessionMock.mockResolvedValue({ fetch: vi.fn().mockResolvedValue(new Response("ok")), close: closeMock });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");

    try {
      await opencodeTlsFetch("https://opencode.ai/a", { proxyUrl: "http://proxy1:8080" });
    } catch {}

    // resetOpencodeTlsSession should not throw
    expect(() => resetOpencodeTlsSession()).not.toThrow();
  });
});