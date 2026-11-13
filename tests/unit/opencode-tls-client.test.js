import { describe, it, expect, vi, beforeEach } from "vitest";

const { createSessionMock, loadRuntimeDepMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  loadRuntimeDepMock: vi.fn(),
}));

vi.mock("../../open-sse/services/lazyRuntime.js", () => ({
  loadRuntimeDep: loadRuntimeDepMock,
}));

describe("opencodeTlsClient", () => {
  beforeEach(() => {
    vi.resetModules();
    createSessionMock.mockReset();
    loadRuntimeDepMock.mockReset();
    loadRuntimeDepMock.mockResolvedValue({ createSession: createSessionMock });
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
    expect(options.proxy).toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://opencode.ai/inference/v1/chat/completions",
      expect.objectContaining({ method: "POST", body: "{}" })
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("text/event-stream");
    expect(result.headers.get("x-9r-proxy-via")).toBeNull();
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

  it("routes the connection through proxyUrl and reports x-9r-proxy-via without credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    const result = await opencodeTlsFetch("https://opencode.ai/a", {}, {
      proxyUrl: "http://user:secret@127.0.0.1:8080",
    });

    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ proxy: "http://user:secret@127.0.0.1:8080" })
    );
    expect(result.headers.get("x-9r-proxy-via")).toBe("http://127.0.0.1:8080");
  });

  it("reuses one session per proxy and isolates different proxies", async () => {
    const fetchA = vi.fn().mockResolvedValue(new Response("a", { status: 200 }));
    const fetchB = vi.fn().mockResolvedValue(new Response("b", { status: 200 }));
    createSessionMock
      .mockResolvedValueOnce({ fetch: fetchA, close: vi.fn() })
      .mockResolvedValueOnce({ fetch: fetchB, close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    await opencodeTlsFetch("https://opencode.ai/a", {}, { proxyUrl: "http://proxy1:8080" });
    await opencodeTlsFetch("https://opencode.ai/b", {}, { proxyUrl: "http://proxy1:8080" });
    await opencodeTlsFetch("https://opencode.ai/c", {}, { proxyUrl: "http://proxy2:8080" });

    expect(createSessionMock).toHaveBeenCalledTimes(2);
    expect(fetchA).toHaveBeenCalledTimes(2);
    expect(fetchB).toHaveBeenCalledTimes(1);
  });

  it("reuses the direct session across requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: vi.fn() });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    await opencodeTlsFetch("https://opencode.ai/a", {});
    await opencodeTlsFetch("https://opencode.ai/b", {});

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("strips proxy credentials from the cache key", async () => {
    const { __test__ } = await import("../../open-sse/services/opencodeTlsClient.js");

    expect(__test__.normalizeProxyKey("http://user:secret@proxy.local:8080")).toBe("http://proxy.local:8080");
    expect(__test__.normalizeProxyKey("socks5://proxy.local:1080")).toBe("socks5://proxy.local:1080");
    expect(__test__.normalizeProxyKey("")).toBe("");
  });

  it("does not close the session when the stream completes", async () => {
    const closeMock = vi.fn();
    const response = new Response(new ReadableStream({
      async pull(controller) {
        controller.enqueue(new TextEncoder().encode("data: ok\n\n"));
        controller.close();
      },
    }), { status: 200 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    createSessionMock.mockResolvedValue({ fetch: fetchMock, close: closeMock });

    const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
    const result = await opencodeTlsFetch("https://opencode.ai/a", {});
    await result.text();

    expect(closeMock).not.toHaveBeenCalled();
  });

  it("resetOpencodeTlsSession closes every cached session", async () => {
    const closeA = vi.fn();
    const closeB = vi.fn();
    createSessionMock
      .mockResolvedValueOnce({ fetch: vi.fn().mockResolvedValue(new Response("a")), close: closeA })
      .mockResolvedValueOnce({ fetch: vi.fn().mockResolvedValue(new Response("b")), close: closeB });

    const { opencodeTlsFetch, resetOpencodeTlsSession } = await import(
      "../../open-sse/services/opencodeTlsClient.js"
    );
    await opencodeTlsFetch("https://opencode.ai/a", {}, { proxyUrl: "http://proxy1:8080" });
    await opencodeTlsFetch("https://opencode.ai/b", {}, { proxyUrl: "http://proxy2:8080" });

    expect(() => resetOpencodeTlsSession()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeA).toHaveBeenCalled();
    expect(closeB).toHaveBeenCalled();
  });
});
