// SeekAI model discovery + key validation through the real route handlers.
// Upstream HTTP is mocked (global fetch stub) — no real key, no live calls.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const FAKE_KEY = "sk-seekai-test-fake-key";

const fetchMock = vi.fn();

vi.mock("next/server", () => ({
  NextResponse: {
    json(body, init = {}) {
      return new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-seekai-"));
process.env.DATA_DIR = tempDir;
vi.stubGlobal("fetch", (...args) => fetchMock(...args));

const { POST: createConnection } = await import("@/app/api/providers/route.js");
const { GET: listModels } = await import("@/app/api/providers/[id]/models/route.js");
const { POST: validateKey } = await import("@/app/api/providers/validate/route.js");
const { createProviderConnection } = await import("@/models/index.js");

function postRequest(body) {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// New API /v1/models envelope (OpenAI-compatible shape, bare ids)
const newApiCatalog = {
  object: "list",
  data: [
    { id: "claude-sonnet-5", object: "model", created: 1788000000, owned_by: "anthropic" },
    { id: "gpt-5.6", object: "model", created: 1788000000, owned_by: "openai" },
  ],
};

const okJson = (payload) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});

let connectionId;
beforeAll(async () => {
  const res = await createConnection(postRequest({ provider: "seekai", apiKey: FAKE_KEY, name: "SeekAI Test" }));
  expect(res.status).toBe(201);
  const json = await res.json();
  // The API key must never be echoed back on creation
  expect(JSON.stringify(json)).not.toContain(FAKE_KEY);
  connectionId = json.connection.id;
  expect(connectionId).toBeTruthy();
});

afterAll(() => {
  vi.unstubAllGlobals();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Windows may hold the sqlite handle briefly; the OS temp cleaner reaps it
  }
});

beforeEach(() => fetchMock.mockReset());

describe("SeekAI model discovery (authenticated /v1/models)", () => {
  it("lists live models with ids preserved verbatim", async () => {
    fetchMock.mockResolvedValue(okJson(newApiCatalog));
    const res = await listModels(new Request("http://localhost/api/x"), { params: Promise.resolve({ id: connectionId }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.models.map((m) => m.id)).toEqual(["claude-sonnet-5", "gpt-5.6"]);
    // No duplicates, no namespace rewriting
    expect(new Set(json.models.map((m) => m.id)).size).toBe(json.models.length);
    // Key sent server-side as Bearer to the exact discovery URL (no /v1 doubling)
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://seekai.cc/v1/models");
    expect(opts.headers["Authorization"]).toBe(`Bearer ${FAKE_KEY}`);
  });

  it("returns an empty list (no crash) on malformed payloads", async () => {
    for (const payload of [{}, { data: null }, { object: "list" }, []]){
      fetchMock.mockResolvedValue(okJson(payload));
      const res = await listModels(new Request("http://localhost/api/x"), { params: Promise.resolve({ id: connectionId }) });
      expect(res.status).toBe(200);
      expect((await res.json()).models).toEqual([]);
    }
  });

  it("reports upstream 401 without leaking the key", async () => {
    fetchMock.mockResolvedValue(new Response("Invalid token", { status: 401 }));
    const res = await listModels(new Request("http://localhost/api/x"), { params: Promise.resolve({ id: connectionId }) });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(FAKE_KEY);
  });

  it("rejects a connection with no key before any network call", async () => {
    const conn = await createProviderConnection({
      provider: "seekai",
      authType: "apikey",
      name: "SeekAI Keyless",
      apiKey: "",
    });
    const res = await listModels(new Request("http://localhost/api/x"), { params: Promise.resolve({ id: conn.id }) });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("SeekAI key validation", () => {
  it("accepts a key the upstream answers 200 for", async () => {
    fetchMock.mockResolvedValue(okJson(newApiCatalog));
    const res = await validateKey(postRequest({ provider: "seekai", apiKey: FAKE_KEY }));
    const json = await res.json();
    expect(json.valid).toBe(true);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://seekai.cc/v1/models");
    expect(opts.headers["Authorization"]).toBe(`Bearer ${FAKE_KEY}`);
  });

  it("rejects a key the upstream answers 401/403 for, without echoing it", async () => {
    for (const status of [401, 403]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(new Response("nope", { status }));
      const res = await validateKey(postRequest({ provider: "seekai", apiKey: "sk-wrong" }));
      const json = await res.json();
      expect(json.valid).toBe(false);
      expect(JSON.stringify(json)).not.toContain("sk-wrong");
    }
  });
});
