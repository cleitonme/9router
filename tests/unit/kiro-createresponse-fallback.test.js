import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const proxyFetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => ({
  ...(await importOriginal()),
  proxyAwareFetch: (...args) => proxyFetchMock(...args),
}));

const { KiroExecutor } = await import("../../open-sse/executors/kiro.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");
const {
  buildKiroCreateResponseUrl,
  buildKiroCreateResponseBody,
  buildKiroCreateResponseHeaders,
} = await import("../../open-sse/utils/kiroCreateResponse.js");

const rateExceeded = () => new Response(
  JSON.stringify({ message: "Too many requests", reason: "USER_REQUEST_RATE_EXCEEDED" }),
  { status: 429, headers: { "content-type": "application/json" } },
);

const sseResponse = () => new Response(
  'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
  { status: 200, headers: { "content-type": "text/event-stream" } },
);

const credentials = {
  accessToken: "token_123",
  providerSpecificData: {
    authMethod: "builder-id",
    clientId: "client-id",
    profileArn: "arn:aws:codewhisperer:us-east-1:12345:profile/TEST",
  },
};

const conversationBody = (overrides = {}) => ({
  conversationState: {
    conversationId: "conv-uuid-123",
    history: [
      { userInputMessage: { content: "What is the weather?" } },
      {
        assistantResponseMessage: {
          content: "Let me check.",
          toolUses: [{ toolUseId: "tool_call_1", name: "get_weather", input: { location: "Tokyo" } }],
        },
      },
      {
        userInputMessage: {
          userInputMessageContext: {
            toolResults: [{ toolUseId: "tool_call_1", content: [{ text: "Sunny, 22C" }] }],
          },
        },
      },
    ],
    currentMessage: {
      userInputMessage: {
        content: "And in Kyoto?",
        modelId: "claude-opus-5.5",
        origin: "AI_EDITOR",
        userInputMessageContext: {
          tools: [
            {
              toolSpecification: {
                name: "get_weather",
                description: "Get weather for location",
                inputSchema: { json: { type: "object", properties: { location: { type: "string" } } } },
              },
            },
          ],
        },
      },
    },
  },
  profileArn: "arn:aws:codewhisperer:us-east-1:12345:profile/TEST",
  additionalModelRequestFields: {
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "high" },
  },
  inferenceConfig: { maxTokens: 32000, temperature: 0.4, topP: 0.9 },
  ...overrides,
});

let originalMode;

beforeEach(() => {
  originalMode = process.env.NINEROUTER_KIRO_CREATE_RESPONSE;
  delete process.env.NINEROUTER_KIRO_CREATE_RESPONSE;
  delete process.env.KIRO_CREATE_RESPONSE;
  proxyFetchMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalMode === undefined) delete process.env.NINEROUTER_KIRO_CREATE_RESPONSE;
  else process.env.NINEROUTER_KIRO_CREATE_RESPONSE = originalMode;
  delete process.env.KIRO_CREATE_RESPONSE;
});

describe("Kiro CreateResponse (/v1/responses) adapter", () => {
  it("builds a regional endpoint and rejects a region that could escape the host", () => {
    expect(buildKiroCreateResponseUrl()).toBe("https://runtime.us-east-1.kiro.dev/v1/responses");
    expect(buildKiroCreateResponseUrl("eu-central-1")).toBe("https://runtime.eu-central-1.kiro.dev/v1/responses");
    expect(buildKiroCreateResponseUrl("")).toBe("https://runtime.us-east-1.kiro.dev/v1/responses");
    expect(buildKiroCreateResponseUrl("evil.com/x")).toBe("https://runtime.us-east-1.kiro.dev/v1/responses");
    expect(buildKiroCreateResponseUrl("us-east-1?x=1")).toBe("https://runtime.us-east-1.kiro.dev/v1/responses");
  });

  it("keeps the shared Kiro identity on every auth method", () => {
    const headers = buildKiroCreateResponseHeaders({ credentials });
    expect(headers.Authorization).toBe("Bearer token_123");
    expect(headers["x-amz-sso-bearer"]).toBe("token_123");
    expect(headers["User-Agent"]).toMatch(/KiroIDE-1\.4\.154/);
    expect(headers["x-amz-user-agent"]).toMatch(/KiroIDE-1\.4\.154-[0-9a-f]{64}$/);
    expect(headers["x-amzn-kiro-profile"]).toBe("arn:aws:codewhisperer:us-east-1:12345:profile/TEST");
    expect(headers.TokenType).toBeUndefined();

    const apiKeyHeaders = buildKiroCreateResponseHeaders({
      credentials: { apiKey: "secret_key", providerSpecificData: { authMethod: "api_key" } },
    });
    expect(apiKeyHeaders.Authorization).toBe("Bearer secret_key");
    expect(apiKeyHeaders.TokenType).toBe("API_KEY");

    const idpHeaders = buildKiroCreateResponseHeaders({
      credentials: { accessToken: "token_ext", providerSpecificData: { authMethod: "external_idp" } },
    });
    expect(idpHeaders.TokenType).toBe("EXTERNAL_IDP");
  });

  it("translates conversationState, tools, reasoning and inference config", () => {
    const result = buildKiroCreateResponseBody({ body: conversationBody(), credentials, model: "kr/claude-opus-5.5" });

    expect(result.model).toBe("claude-opus-5.5");
    expect(result.stream).toBe(true);
    expect(result.metadata).toEqual({
      "kiro:agent_mode": "vibe",
      "kiro:conversation_id": "conv-uuid-123",
    });
    expect(result.reasoning).toEqual({ type: "adaptive", effort: "high", summary: "summarized" });
    expect(result.max_output_tokens).toBe(32000);
    expect(result.temperature).toBe(0.4);
    expect(result.top_p).toBe(0.9);

    expect(result.input).toEqual([
      { role: "user", content: "What is the weather?" },
      { role: "assistant", content: "Let me check." },
      {
        type: "function_call",
        call_id: "tool_call_1",
        name: "get_weather",
        arguments: JSON.stringify({ location: "Tokyo" }),
      },
      { type: "function_call_output", call_id: "tool_call_1", output: "Sunny, 22C" },
      { role: "user", content: "And in Kyoto?" },
    ]);
    expect(result.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Get weather for location",
        parameters: { type: "object", properties: { location: { type: "string" } } },
      },
    ]);
  });

  it("maps images into Responses input_image blocks", () => {
    const result = buildKiroCreateResponseBody({
      body: {
        conversationState: {
          currentMessage: {
            userInputMessage: {
              content: "Describe this image",
              modelId: "claude-opus-5.5",
              images: [{ format: "jpeg", source: { bytes: "aGVsbG8=" } }],
            },
          },
        },
      },
      credentials,
      model: "claude-opus-5.5",
    });

    expect(result.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "Describe this image" },
          { type: "input_image", image_url: "data:image/jpeg;base64,aGVsbG8=" },
        ],
      },
    ]);
  });
});

describe("KiroExecutor CreateResponse execution", () => {
  it("returns raw upstream SSE tagged as openai-responses", async () => {
    proxyFetchMock.mockResolvedValueOnce(sseResponse());
    const result = await new KiroExecutor().executeCreateResponse({
      model: "kr/claude-opus-5.5",
      body: conversationBody(),
      credentials,
    });

    expect(proxyFetchMock).toHaveBeenCalledTimes(1);
    expect(result.responseFormat).toBe(FORMATS.OPENAI_RESPONSES);
    expect(result.url).toBe("https://runtime.us-east-1.kiro.dev/v1/responses");
    expect(await result.response.text()).toContain("response.output_text.delta");
  });

  it("retries once when CreateResponse also answers 429", async () => {
    proxyFetchMock.mockResolvedValueOnce(rateExceeded()).mockResolvedValueOnce(sseResponse());
    const result = await new KiroExecutor().executeCreateResponse({
      model: "kr/claude-opus-5.5",
      body: conversationBody(),
      credentials,
    });

    expect(proxyFetchMock).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(200);
  });

  it("falls back to CreateResponse on 429 USER_REQUEST_RATE_EXCEEDED", async () => {
    const executor = new KiroExecutor();
    const fallbackResult = { response: sseResponse(), responseFormat: FORMATS.OPENAI_RESPONSES };
    const createResponse = vi.spyOn(executor, "executeCreateResponse").mockResolvedValue(fallbackResult);
    const legacyExecute = vi.spyOn(Object.getPrototypeOf(KiroExecutor.prototype), "execute").mockResolvedValue({
      response: rateExceeded(),
      url: "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
      headers: {},
      transformedBody: {},
    });

    const result = await executor.execute({
      model: "kr/claude-opus-5.5",
      body: conversationBody(),
      credentials,
    });

    expect(legacyExecute).toHaveBeenCalledTimes(1);
    expect(createResponse).toHaveBeenCalledTimes(1);
    expect(result).toBe(fallbackResult);
  });

  it("keeps the legacy 429 when CreateResponse also fails", async () => {
    const executor = new KiroExecutor();
    vi.spyOn(Object.getPrototypeOf(KiroExecutor.prototype), "execute").mockResolvedValue({
      response: rateExceeded(),
      url: "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
      headers: {},
      transformedBody: {},
    });
    proxyFetchMock.mockResolvedValue(new Response("denied", { status: 403 }));

    const result = await executor.execute({
      model: "kr/claude-opus-5.5",
      body: conversationBody(),
      credentials,
    });

    expect(result.response.status).toBe(429);
    expect(result.responseFormat).toBeUndefined();
  });

  it("does not fall back for an unrelated 429 body", async () => {
    const executor = new KiroExecutor();
    const createResponse = vi.spyOn(executor, "executeCreateResponse");
    vi.spyOn(Object.getPrototypeOf(KiroExecutor.prototype), "execute").mockResolvedValue({
      response: new Response(JSON.stringify({ message: "slow down" }), { status: 429 }),
      url: "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
      headers: {},
      transformedBody: {},
    });

    const result = await executor.execute({ model: "kr/claude-opus-5.5", body: conversationBody(), credentials });

    expect(createResponse).not.toHaveBeenCalled();
    expect(result.response.status).toBe(429);
  });

  it("skips the fallback for credentials runtime.kiro.dev rejects", async () => {
    const executor = new KiroExecutor();
    const createResponse = vi.spyOn(executor, "executeCreateResponse");
    vi.spyOn(Object.getPrototypeOf(KiroExecutor.prototype), "execute").mockResolvedValue({
      response: rateExceeded(),
      url: "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
      headers: {},
      transformedBody: {},
    });

    const result = await executor.execute({
      model: "kr/claude-opus-5.5",
      body: conversationBody(),
      credentials: { apiKey: "key", providerSpecificData: { authMethod: "api_key" } },
    });

    expect(createResponse).not.toHaveBeenCalled();
    expect(result.response.status).toBe(429);
  });

  it("honours NINEROUTER_KIRO_CREATE_RESPONSE=off", async () => {
    process.env.NINEROUTER_KIRO_CREATE_RESPONSE = "off";
    const executor = new KiroExecutor();
    const createResponse = vi.spyOn(executor, "executeCreateResponse");
    vi.spyOn(Object.getPrototypeOf(KiroExecutor.prototype), "execute").mockResolvedValue({
      response: rateExceeded(),
      url: "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
      headers: {},
      transformedBody: {},
    });

    const result = await executor.execute({ model: "kr/claude-opus-5.5", body: conversationBody(), credentials });

    expect(createResponse).not.toHaveBeenCalled();
    expect(result.response.status).toBe(429);
  });

  it("does not touch CreateResponse when the legacy surface succeeds", async () => {
    const executor = new KiroExecutor();
    const createResponse = vi.spyOn(executor, "executeCreateResponse");
    vi.spyOn(Object.getPrototypeOf(KiroExecutor.prototype), "execute").mockResolvedValue({
      response: new Response(new Uint8Array(0), { status: 200 }),
      url: "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
      headers: {},
      transformedBody: {},
    });
    vi.spyOn(executor, "attachIntegrityGate").mockImplementation(() => {});

    const result = await executor.execute({ model: "kr/claude-opus-5.5", body: conversationBody(), credentials });

    expect(createResponse).not.toHaveBeenCalled();
    expect(result.response.status).toBe(200);
  });
});
