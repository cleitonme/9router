/**
 * Kiro CreateResponse (/v1/responses) protocol adapter.
 *
 * The upstream already speaks the OpenAI Responses API, so this module only
 * builds the request (URL, auth headers, body) and hands the raw SSE stream to
 * the executor. Conversion to the client format stays in the translator layer
 * (openaiResponsesToOpenAIResponse), which already handles reasoning, parallel
 * tool calls, usage and finish reasons.
 */
import { buildKiroIdentityHeaders } from "../shared/kiroIdentity.js";
import { KIRO_CREATE_RESPONSE, KIRO_REGION_PATTERN } from "../config/kiroClient.js";

/** Normalize a credential region, falling back when it is not a safe AWS shape. */
export function normalizeKiroCreateResponseRegion(region) {
  const candidate = typeof region === "string" ? region.trim() : "";
  return KIRO_REGION_PATTERN.test(candidate) ? candidate : KIRO_CREATE_RESPONSE.defaultRegion;
}

/** Build the regional CreateResponse endpoint. */
export function buildKiroCreateResponseUrl(region = KIRO_CREATE_RESPONSE.defaultRegion) {
  const safeRegion = normalizeKiroCreateResponseRegion(region);
  return KIRO_CREATE_RESPONSE.urlTemplate.replace("{region}", safeRegion);
}

function imageUrl(image) {
  const bytes = image?.source?.bytes;
  if (!bytes) return null;
  const format = String(image.format || "png").toLowerCase();
  return `data:image/${format};base64,${bytes}`;
}

function toolInputArguments(input) {
  if (typeof input === "string") return input;
  return JSON.stringify(input ?? {});
}

/**
 * Convert the translated Kiro conversationState payload into a CreateResponse
 * request body.
 */
export function buildKiroCreateResponseBody({ body, credentials, model }) {
  const state = body?.conversationState;
  const current = state?.currentMessage;
  const input = [];

  for (const turn of [...(state?.history || []), current].filter(Boolean)) {
    const user = turn.userInputMessage;
    if (user) {
      for (const result of user.userInputMessageContext?.toolResults || []) {
        input.push({
          type: "function_call_output",
          call_id: result.toolUseId,
          output: (result.content || []).map((part) => part.text ?? "").join("\n"),
        });
      }

      const images = (user.images || []).map(imageUrl).filter(Boolean).map((url) => ({
        type: "input_image",
        image_url: url,
      }));
      const text = typeof user.content === "string" ? user.content : "";
      if (images.length > 0) {
        input.push({
          role: "user",
          content: [...(text ? [{ type: "input_text", text }] : []), ...images],
        });
      } else if (text) {
        input.push({ role: "user", content: text });
      }
    }

    const assistant = turn.assistantResponseMessage;
    if (assistant) {
      if (typeof assistant.content === "string" && assistant.content) {
        input.push({ role: "assistant", content: assistant.content });
      }
      for (const call of assistant.toolUses || []) {
        input.push({
          type: "function_call",
          call_id: call.toolUseId,
          name: call.name,
          arguments: toolInputArguments(call.input),
        });
      }
    }
  }

  const tools = [];
  for (const tool of current?.userInputMessage?.userInputMessageContext?.tools || []) {
    const spec = tool.toolSpecification;
    if (!spec?.name) continue;
    tools.push({
      type: "function",
      name: spec.name,
      description: spec.description || "",
      parameters: spec.inputSchema?.json || {},
    });
  }

  const fields = body?.additionalModelRequestFields;
  const nonEmpty = (value) => (typeof value === "string" && value ? value : undefined);
  const type = nonEmpty(fields?.thinking?.type);
  const effort = nonEmpty(fields?.output_config?.effort) ?? nonEmpty(fields?.reasoning?.effort);
  const summary = nonEmpty(fields?.thinking?.display);
  const reasoning = type || effort || summary
    ? {
        ...(type ? { type } : {}),
        ...(effort ? { effort } : {}),
        ...(summary ? { summary } : {}),
      }
    : null;

  const inference = body?.inferenceConfig || {};
  const maxOutputTokens = Number.isFinite(inference.maxTokens) ? inference.maxTokens : null;
  const temperature = Number.isFinite(inference.temperature) ? inference.temperature : null;
  const topP = Number.isFinite(inference.topP) ? inference.topP : null;

  const profileArn = body?.profileArn || credentials?.providerSpecificData?.profileArn;
  const conversationId = state?.conversationId;
  const resolvedModel = current?.userInputMessage?.modelId || body?._kiroUpstreamModel || model;

  return {
    model: resolvedModel,
    input,
    ...(tools.length ? { tools } : {}),
    stream: true,
    origin: current?.userInputMessage?.origin || "AI_EDITOR",
    ...(profileArn ? { profileArn } : {}),
    metadata: {
      "kiro:agent_mode": KIRO_CREATE_RESPONSE.agentMode,
      ...(conversationId ? { "kiro:conversation_id": conversationId } : {}),
    },
    ...(reasoning ? { reasoning } : {}),
    ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
    ...(temperature != null ? { temperature } : {}),
    ...(topP != null ? { top_p: topP } : {}),
  };
}

/** Build the request headers for CreateResponse, keeping the shared Kiro identity. */
export function buildKiroCreateResponseHeaders({ credentials, body }) {
  const authMethod = credentials?.providerSpecificData?.authMethod;
  const profileArn = credentials?.providerSpecificData?.profileArn || body?.profileArn;

  const headers = {
    ...buildKiroIdentityHeaders(credentials, "runtime"),
    "User-Agent": KIRO_CREATE_RESPONSE.userAgent,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "x-amzn-kiro-origin": "AI_EDITOR",
    "x-amzn-kiro-agent-mode": KIRO_CREATE_RESPONSE.agentMode,
    "x-amzn-codewhisperer-optout": "true",
    "Amz-Sdk-Request": "attempt=1; max=3",
  };

  if (profileArn) headers["x-amzn-kiro-profile"] = profileArn;

  const apiKey = credentials?.apiKey || (authMethod === "api_key" ? credentials?.accessToken : null);
  if (authMethod === "api_key" && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers.TokenType = "API_KEY";
  } else if (credentials?.accessToken) {
    headers.Authorization = `Bearer ${credentials.accessToken}`;
    if (authMethod === "external_idp") headers.TokenType = "EXTERNAL_IDP";
  }

  if (credentials?.accessToken) headers["x-amz-sso-bearer"] = credentials.accessToken;

  return headers;
}
