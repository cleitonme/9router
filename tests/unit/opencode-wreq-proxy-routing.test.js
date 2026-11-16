// wreq-js owns its own TCP+TLS layer (TLS impersonation), so it cannot ride an
// undici dispatcher. These cases pin the wiring that makes a Proxy Pool
// selection actually carry the connection:
//
//   1. proxyFetch: a `proxyCapable` adapter receives the resolved proxy URL and
//      is never swapped for an undici ProxyAgent (that would drop impersonation).
//   2. proxyFetch: a non-proxyCapable adapter stays off the proxy path, so the
//      proxy still carries the request instead of being silently bypassed.
//   3. opencode executor: forwards the proxy URL it is handed to wreq-js.
//
// Regression class: "the pool is configured, a proxy was selected, and the
// request still left through the server's direct interface" - configuration
// without transport participation.
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

const { tlsFetchMock } = vi.hoisted(() => ({ tlsFetchMock: vi.fn() }));

vi.mock("../../open-sse/services/opencodeTlsClient.js", () => ({
  opencodeTlsFetch: tlsFetchMock,
  resetOpencodeTlsSession: vi.fn(),
  OpencodeTlsUnavailableError: class extends Error {},
}));

const ENV_PROXY_KEYS = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
];

describe("proxyAwareFetch delegates the proxy to the transport adapter", () => {
  beforeEach(() => {
    for (const key of ENV_PROXY_KEYS) vi.stubEnv(key, "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("hands the resolved proxy URL to a proxyCapable directFetch instead of bypassing it", async () => {
    const adapter = Object.assign(vi.fn().mockResolvedValue(new Response("ok", { status: 200 })), {
      proxyCapable: true,
    });
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", {
      method: "POST",
      body: "{}",
      directFetch: adapter,
    }, { connectionProxyEnabled: true, connectionProxyUrl: "socks5://127.0.0.1:9050" });

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(adapter.mock.calls[0][2].proxyUrl).toBe("socks5://127.0.0.1:9050");
  });

  it("keeps a non-proxyCapable adapter off the proxy path so the proxy still carries it", async () => {
    // codex-style adapter: owns the transport but knows nothing about proxies.
    // Handing it the proxy URL would leave over the direct interface.
    const adapter = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await expect(proxyAwareFetch("https://invalid.invalid/a", { directFetch: adapter },
      { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:1", strictProxy: true }))
      .rejects.toThrow();

    expect(adapter).not.toHaveBeenCalled();
  });

  it("uses the adapter path unchanged when no proxy is configured", async () => {
    const adapter = Object.assign(vi.fn().mockResolvedValue(new Response("ok", { status: 200 })), {
      proxyCapable: true,
    });
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await proxyAwareFetch("https://opencode.ai/a", { directFetch: adapter });

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(adapter.mock.calls[0][2].proxyUrl).toBeNull();
  });

  it("fail-closed: strictProxy surfaces the adapter failure instead of falling back to direct", async () => {
    const adapter = Object.assign(vi.fn().mockRejectedValue(new Error("proxy tunnel refused")), {
      proxyCapable: true,
    });
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await expect(proxyAwareFetch("https://opencode.ai/a", { directFetch: adapter },
      { connectionProxyEnabled: true, connectionProxyUrl: "socks5://127.0.0.1:9050", strictProxy: true }))
      .rejects.toThrow(/strictProxy=true/);
  });

  it("never replays a failed proxyCapable adapter without the proxy", async () => {
    const adapter = Object.assign(vi.fn().mockRejectedValue(new Error("proxy tunnel refused")), {
      proxyCapable: true,
    });
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

    await expect(proxyAwareFetch("https://opencode.ai/a", { directFetch: adapter },
      { connectionProxyEnabled: true, connectionProxyUrl: "socks5://127.0.0.1:9050" }))
      .rejects.toThrow(/proxy tunnel refused/);

    expect(adapter).toHaveBeenCalledTimes(1);
  });
});

describe("opencode executor forwards the resolved proxy", () => {
  it("passes the proxy URL through to opencodeTlsFetch", async () => {
    vi.resetModules();
    tlsFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");
    const exec = new OpenCodeExecutor();

    try {
      await exec.execute({
        model: "oc/gpt-oss-120b",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: true,
        credentials: {},
        proxyOptions: {
          connectionProxyEnabled: true,
          connectionProxyUrl: "socks5://127.0.0.1:9050",
        },
      });
    } catch {
      // execute() talks to the real network upstream; the wiring assertion is
      // on the adapter call below, not on its outcome.
    }

    expect(tlsFetchMock).toHaveBeenCalled();
    expect(tlsFetchMock.mock.calls[0][2].proxyUrl).toBe("socks5://127.0.0.1:9050");

  });
});

