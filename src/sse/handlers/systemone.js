import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings, getProviderConnections } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleSystemoneCore } from "open-sse/handlers/systemoneCore.js";
import {
  resolveSystemoneTargets,
  discoverSystemoneModels,
  buildSystemoneSuccessEnvelope,
  shouldUseSystemoneEnvelope,
  systemoneRoutingHeaders,
  systemoneEnvelopeResponse,
} from "open-sse/services/systemoneRouting.js";
import { isGatewayBlocked, isLogicalProviderBlocked } from "open-sse/services/providerLock.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";
import { checkAndRefreshToken } from "../services/tokenRefresh.js";
import { saveRequestUsage } from "@/lib/usageDb.js";

/**
 * Handle System One (Jev) decision requests for the Next.js server.
 * Follows the same auth + account-fallback pattern as handleEmbeddings.
 *
 * Modes:
 * - single (legacy): `{ "model": "provider/id", ... }` → native upstream
 *   JSON passed through byte-identical (no envelope).
 * - combo/auto: `{ "mode": "combo"|"auto", "models": [...], ... }` or
 *   `{ "model": "auto", "models": [...], ... }` → sequential fallback by
 *   list order (v1 scope). A provider error never aborts the combo; the
 *   winner is returned inside a routing envelope.
 * - auto zero-config: `{ "model": "auto", ... }` with no `models` list →
 *   candidates are discovered from providers that have SystemOne support
 *   and usable credentials (noAuth free lanes first), unless disabled via
 *   `settings.systemoneAutoEnabled === false`.
 *
 * @param {Request} request
 */
export async function handleSystemone(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("SYSTEMONE", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const modelStr = body.model;

  log.request("POST", `${url.pathname} | ${modelStr}`);

  // Log API key (masked)
  const apiKey = extractApiKey(request);
  if (apiKey) {
    log.debug("AUTH", `API Key: ${log.maskKey(apiKey)}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("SYSTEMONE", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }
  if (body.state === undefined || body.state === null) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: state");
  }
  if (!body.questions || typeof body.questions !== "object" || Array.isArray(body.questions)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: questions");
  }

  // v1: strategy/criteria fields are accepted but treated as sequential
  // fallback — logged so clients can send the full contract safely.
  const strategy = body?.combo?.strategy || body?.routing?.strategy || null;
  if (strategy && strategy !== "fallback") {
    log.debug("SYSTEMONE", `Strategy "${strategy}" accepted as sequential fallback (v1 scope)`);
  }

  // Resolve single vs combo/auto targets (combo names expand via localDb).
  // Zero-config auto: no models list → discover from available providers.
  let targets;
  try {
    targets = await resolveSystemoneTargets(body, (name) => getComboModels(name));
  } catch (err) {
    if (err?.code === "MISSING_MODELS") {
      const modeRaw = typeof body?.mode === "string" ? body.mode.toLowerCase() : null;
      const isAuto = body?.model === "auto" || modeRaw === "auto";
      if (!isAuto) {
        log.warn("SYSTEMONE", err.message);
        return errorResponse(HTTP_STATUS.BAD_REQUEST, err.message);
      }
      if (settings.systemoneAutoEnabled === false) {
        log.warn("SYSTEMONE", "Auto discovery disabled by settings");
        return errorResponse(HTTP_STATUS.BAD_REQUEST, "Auto model discovery is disabled");
      }
      const discovered = await discoverSystemoneModels({
        entries: REGISTRY,
        hasCredentials: async (providerId) => {
          try {
            const conns = await getProviderConnections({ provider: providerId, isActive: true });
            return Array.isArray(conns) && conns.length > 0;
          } catch {
            return false;
          }
        },
        isBlocked: (providerId) => !!(isGatewayBlocked(providerId) || isLogicalProviderBlocked(providerId)),
      });
      if (discovered.length === 0) {
        log.warn("SYSTEMONE", "Auto discovery found no available SystemOne providers");
        return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "No SystemOne providers available");
      }
      log.info("SYSTEMONE", `auto discovered ${discovered.length} models: ${discovered.join(", ")}`);
      targets = { mode: "auto", models: discovered, autoDiscovered: true };
    } else {
      throw err;
    }
  }

  if (targets.mode === "single") {
    return handleSingleSystemone({ body, modelStr, apiKey, url });
  }

  return handleMultiSystemone({ body, targets, apiKey, url });
}

async function handleSingleSystemone({ body, modelStr, apiKey, url }) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) {
    log.warn("SYSTEMONE", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  if (modelStr !== `${provider}/${model}`) {
    log.info("ROUTING", `${modelStr} → ${provider}/${model}`);
  } else {
    log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);
  }

  const result = await trySingleSystemoneModel({ body, modelStr, provider, model });

  if (result.ok) {
    if (result.usage) {
      saveRequestUsage({
        provider,
        model,
        connectionId: result.connectionId,
        apiKey,
        endpoint: url.pathname,
        tokens: {
          ...result.usage,
          total_tokens: result.usage.prompt_tokens + result.usage.completion_tokens,
        },
        status: "success",
      }).catch(() => {});
    }
    return result.response;
  }

  return result.response;
}

async function handleMultiSystemone({ body, targets, apiKey, url }) {
  const { mode, models, autoDiscovered } = targets;
  log.info("SYSTEMONE", `${mode} with ${models.length} models (strategy: fallback, sequential${autoDiscovered ? ", auto-discovered" : ""})`);

  // Multitenant whitelist (mirrors handleChat): filter candidates per user.
  let candidates = models;
  if (apiKey) {
    try {
      const { resolveApiKeyUser } = await import("@/sse/services/auth.js");
      const tenantUser = await resolveApiKeyUser(apiKey);
      const allowedModels = tenantUser?.allowedModels || [];
      const allowedCombos = tenantUser?.allowedCombos || [];
      if (tenantUser && (allowedModels.length > 0 || allowedCombos.length > 0)) {
        const { getComboById, getComboByName } = await import("@/lib/localDb");
        const permitted = [];
        for (const m of models) {
          if (allowedModels.includes(m)) {
            permitted.push(m);
            continue;
          }
          let ok = false;
          for (const comboRef of allowedCombos) {
            const comboObj = (await getComboById(comboRef)) || (await getComboByName(comboRef));
            if (comboObj && (comboObj.name === m || comboObj.id === m || (Array.isArray(comboObj.models) && comboObj.models.includes(m)))) {
              ok = true;
              break;
            }
          }
          if (ok) permitted.push(m);
          else log.warn("SYSTEMONE", `Model "${m}" not allowed for user ${tenantUser.username}, skipping`);
        }
        if (permitted.length === 0) {
          log.warn("SYSTEMONE", `No allowed models for user ${tenantUser.username} in ${mode} list`);
          return errorResponse(HTTP_STATUS.FORBIDDEN, "None of the requested models are allowed for your account.");
        }
        candidates = permitted;
      }
    } catch {
      // fail-open: if tenant resolution fails, try the full list
    }
  }

  const attempted = [];
  const errors = [];
  // Envelope is opt-in only. Default is the native upstream body (same shape
  // as single-model), so clients that only swap the model keep working.
  const wantEnvelope = shouldUseSystemoneEnvelope(body, url?.searchParams);

  for (let i = 0; i < candidates.length; i++) {
    const candidateStr = candidates[i];
    attempted.push(candidateStr);

    const modelInfo = await getModelInfo(candidateStr);
    if (!modelInfo.provider) {
      const msg = "Invalid model format";
      log.warn("SYSTEMONE", `${msg}, skipping`, { model: candidateStr });
      errors.push({ model: candidateStr, status: HTTP_STATUS.BAD_REQUEST, message: msg });
      continue;
    }
    const { provider, model } = modelInfo;
    log.info("SYSTEMONE", `Trying model ${i + 1}/${candidates.length}: ${candidateStr}`);

    const result = await trySingleSystemoneModel({ body, modelStr: candidateStr, provider, model });

    if (result.ok) {
      if (result.usage) {
        saveRequestUsage({
          provider,
          model,
          connectionId: result.connectionId,
          apiKey,
          endpoint: url.pathname,
          tokens: {
            ...result.usage,
            total_tokens: result.usage.prompt_tokens + result.usage.completion_tokens,
          },
          status: "success",
        }).catch(() => {});
      }
      log.info("SYSTEMONE", `${mode} winner: ${candidateStr} (fallback_used=${i > 0})`);
      const routingHeaders = systemoneRoutingHeaders({
        selectedModel: candidateStr,
        provider,
        mode,
        fallbackUsed: i > 0,
        attempted,
      });
      if (wantEnvelope) {
        const envelope = buildSystemoneSuccessEnvelope({
          data: result.data,
          selectedModel: candidateStr,
          provider,
          mode,
          fallbackUsed: i > 0,
          attempted,
          usage: result.usage,
        });
        if (autoDiscovered) envelope.auto_discovered = true;
        return systemoneEnvelopeResponse(envelope);
      }
      // Native passthrough: identical shape to single-model responses.
      return new Response(JSON.stringify(result.data ?? null), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          ...routingHeaders,
        },
      });
    }

    // A provider error never aborts the combo — record and try next.
    errors.push({ model: candidateStr, status: result.status, message: result.error });
    log.warn("SYSTEMONE", `Model ${candidateStr} failed (${result.status}), trying next`, { error: result.error });
  }

  const lastStatus = errors.length > 0 ? errors[errors.length - 1].status : HTTP_STATUS.SERVICE_UNAVAILABLE;
  const status = lastStatus && lastStatus >= 400 && lastStatus < 600 ? lastStatus : HTTP_STATUS.SERVICE_UNAVAILABLE;
  const lastError = errors.length > 0 ? errors[errors.length - 1].message : "All accounts unavailable";
  log.warn("SYSTEMONE", `All ${candidates.length} ${mode} models failed`);
  // Standard error shape (same contract as single-model failures) — per-model
  // detail stays server-side in logs, never leaks keys.
  return errorResponse(status, `[${mode}] All ${candidates.length} models unavailable (tried: ${attempted.join(", ")}). Last error: ${lastError}`);
}

/**
 * Try one provider/model with the existing credential + account-fallback loop.
 * Never throws for upstream failures — returns `{ ok: false, ... }` so the
 * caller (single or combo) can decide what to do next.
 */
async function trySingleSystemoneModel({ body, modelStr, provider, model }) {
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("SYSTEMONE", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return {
          ok: false,
          status,
          error: `[${provider}/${model}] ${errorMsg}`,
          response: unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman),
        };
      }
      if (excludeConnectionIds.size === 0) {
        log.error("AUTH", `No credentials for provider: ${provider}`);
        return {
          ok: false,
          status: HTTP_STATUS.BAD_REQUEST,
          error: `No credentials for provider: ${provider}`,
          response: errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`),
        };
      }
      log.warn("SYSTEMONE", "No more accounts available", { provider });
      return {
        ok: false,
        status: lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE,
        error: lastError || "All accounts unavailable",
        response: errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable"),
      };
    }

    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    const result = await handleSystemoneCore({
      body: { ...body, model: modelStr },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      }
    });

    if (result.success) {
      return {
        ok: true,
        usage: result.usage,
        data: result.data,
        connectionId: credentials.connectionId,
        response: result.response,
      };
    }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      lastResponse = result.response;
      continue;
    }

    return { ok: false, status: result.status, error: result.error, response: result.response };
  }
}
