import { createErrorResult, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { HTTP_STATUS, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { PROVIDER_MEDIA } from "../providers/index.js";
import { getModelUpstreamId } from "../config/providerModels.js";
import { generateSessionId } from "../executors/opencode-zen.js";
import { sanitizeSystemoneUpstreamBody } from "../services/systemoneRouting.js";

/**
 * Core System One (Jev) handler — native decision payload pass-through.
 * URL/headers come from the registry's systemoneConfig; body and JSON response
 * are forwarded untouched (decision models have no chat translation layer).
 *
 * Gateway-only routing fields (`models`, `mode`, `routing`, `combo`) are
 * stripped before forwarding so upstream lanes only see the native
 * model/state/questions payload.
 *
 * @returns {Promise<{ success: boolean, response: Response, data?: object, usage?: object, status?: number, error?: string }>}
 */
/**
 * Normalize the upstream `usage` object into the gateway token shape.
 * Cloudflare Workers AI (`/ai/run/{model}`) reports
 * `{ prompt_tokens, completion_tokens }`, while other SystemOne lanes report
 * OpenAI-style `{ input_tokens, output_tokens }`. Returns null when the
 * upstream returned no usage at all.
 *
 * @param {object|undefined} rawUsage
 * @returns {{ prompt_tokens: number, completion_tokens: number }|null}
 */
export function normalizeSystemoneUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== "object") return null;
  return {
    prompt_tokens: rawUsage.prompt_tokens ?? rawUsage.input_tokens ?? 0,
    completion_tokens: rawUsage.completion_tokens ?? rawUsage.output_tokens ?? 0,
  };
}

export async function handleSystemoneCore({
  body,
  modelInfo,
  credentials,
  log,
  onRequestSuccess,
}) {
  const { provider, model } = modelInfo;
  const cfg = PROVIDER_MEDIA[provider]?.systemoneConfig;
  let targetUrl = credentials?.providerSpecificData?.baseUrl || cfg?.baseUrl;
  if (!targetUrl) {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      `Provider '${provider}' does not support System One.`
    );
  }
  // Cloudflare-style endpoints embed the account and model in the path.
  if (targetUrl.includes("{accountId}")) {
    const accountId = credentials?.providerSpecificData?.accountId;
    if (!accountId) {
      return createErrorResult(
        HTTP_STATUS.BAD_REQUEST,
        `Provider '${provider}' requires accountId in providerSpecificData.`
      );
    }
    targetUrl = targetUrl.replace("{accountId}", accountId);
  }
  if (targetUrl.includes("{model}")) {
    targetUrl = targetUrl.replace(/\{model\}/g, model);
  }

  // Validate input at the trust boundary; question-level shape is upstream's job.
  if (body.state === undefined || body.state === null) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: state");
  }
  if (!body.questions || typeof body.questions !== "object" || Array.isArray(body.questions)) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: questions");
  }

  // noAuth free lanes carry accessToken "public" from the credential stub.
  const token = credentials?.apiKey || credentials?.accessToken;
  // Zen lanes expect the official client session header on every request.
  const session = generateSessionId();
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(cfg.headers || {}),
    "x-opencode-session": session,
    "x-opencode-session-id": session,
  };
  // Cloudflare validates the body model as a short selector (e.g. "clef-flash"), not the full id.
  const upstreamModel = getModelUpstreamId(provider, model) || model;
  const requestBody = sanitizeSystemoneUpstreamBody(body, upstreamModel);

  log?.debug?.("SYSTEMONE", `${provider.toUpperCase()} | ${model}`);

  // Connection-level proxy (Estratégia de Rotação / proxy pool) — same mapping
  // as chatCore, so per-connection and per-provider-strategy proxies apply here too.
  const proxyOptions = {
    connectionProxyEnabled: credentials?.providerSpecificData?.connectionProxyEnabled === true,
    connectionProxyUrl: credentials?.providerSpecificData?.connectionProxyUrl || "",
    connectionNoProxy: credentials?.providerSpecificData?.connectionNoProxy || "",
    connectionProxyPoolId: credentials?.providerSpecificData?.connectionProxyPoolId || null,
    vercelRelayUrl: credentials?.providerSpecificData?.vercelRelayUrl || "",
  };

  if (proxyOptions.vercelRelayUrl) {
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${credentials?.connectionName || "unknown"} | pool=${proxyOptions.connectionProxyPoolId || "none"} | vercel-relay=${proxyOptions.vercelRelayUrl}`);
  } else if (proxyOptions.connectionProxyEnabled && proxyOptions.connectionProxyUrl) {
    let maskedProxyUrl = proxyOptions.connectionProxyUrl;
    try {
      const parsed = new URL(proxyOptions.connectionProxyUrl);
      maskedProxyUrl = `${parsed.protocol || "http:"}//${parsed.hostname || ""}${parsed.port ? `:${parsed.port}` : ""}`;
    } catch {
      // Keep raw if URL parsing fails
    }
    log?.info?.("PROXY", `${provider.toUpperCase()} | ${model} | conn=${credentials?.connectionName || "unknown"} | pool=${proxyOptions.connectionProxyPoolId || "none"} | url=${maskedProxyUrl}`);
  }

  let providerResponse;
  try {
    providerResponse = await proxyAwareFetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      ...(typeof AbortSignal?.timeout === "function"
        ? { signal: AbortSignal.timeout(FETCH_CONNECT_TIMEOUT_MS) }
        : {}),
    }, proxyOptions);
  } catch (error) {
    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    log?.debug?.("SYSTEMONE", `Fetch error: ${errMsg}`);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  if (!providerResponse.ok) {
    const { statusCode, message } = await parseUpstreamError(providerResponse);
    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    log?.debug?.("SYSTEMONE", `Provider error: ${errMsg}`);
    return createErrorResult(statusCode, errMsg);
  }

  let responseBody;
  try {
    responseBody = await providerResponse.json();
  } catch {
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`);
  }

  if (onRequestSuccess) await onRequestSuccess();

  const usage = normalizeSystemoneUsage(responseBody?.usage);
  return {
    success: true,
    data: responseBody,
    usage,
    response: new Response(JSON.stringify(responseBody), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}
