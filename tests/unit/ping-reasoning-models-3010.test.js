// Issue #3010 — Dashboard "Test" button fails for reasoning models because it
// waits for a full answer. pingModelByKind now streams and stops at the first
// token, so a reasoning-only (length-limited) response is a successful
// connection instead of a timeout.
//
// The route module pulls in Next.js-only deps (@/lib/localDb, etc.) that don't
// resolve under raw vitest, so we mock them and exercise the exported function.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the heavy Next.js-dependent imports BEFORE importing ping.js.
vi.mock("@/lib/localDb", () => ({ getApiKeys: vi.fn(async () => [{ key: "test-key", isActive: true }]) }));
vi.mock("@/shared/constants/config", () => ({ UPDATER_CONFIG: { appPort: 20127 } }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: vi.fn(async () => "cli-token") }));

const { pingModelByKind } = await import("../../src/app/api/models/test/ping.js");

describe("pingModelByKind reasoning models (#3010)", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sseResponse(events) {
    const body = events
      .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
      .join("");
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }

  it("streams the chat completions probe with a sane budget", async () => {
    fetchMock.mockResolvedValue(sseResponse([
      { choices: [{ delta: { content: "Hi there!" } }] },
      "[DONE]",
    ]));

    await pingModelByKind("cline-pass/kimi-k3", "llm", "http://127.0.0.1:20127");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(1024);
    expect(body.stream).toBe(true);
  });

  it("treats a reasoning-only first frame as ok:true", async () => {
    fetchMock.mockResolvedValue(sseResponse([
      { choices: [{ delta: { reasoning: "The user said hi — a simple greeting..." } }] },
      "[DONE]",
    ]));

    const result = await pingModelByKind("cline-pass/kimi-k3", "llm", "http://127.0.0.1:20127");
    expect(result.ok).toBe(true);
  });

  it("still fails when the stream carries no completion data", async () => {
    fetchMock.mockResolvedValue(sseResponse([
      { choices: [] },
      "[DONE]",
    ]));
    const result = await pingModelByKind("some/model", "llm", "http://127.0.0.1:20127");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no completion data/);
  });

  it("passes a normal streamed answer", async () => {
    fetchMock.mockResolvedValue(sseResponse([
      { choices: [{ delta: { content: "Hello!" } }] },
      "[DONE]",
    ]));
    const result = await pingModelByKind("openai/gpt-4o", "llm", "http://127.0.0.1:20127");
    expect(result.ok).toBe(true);
  });
});
