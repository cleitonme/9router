import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse, parseResetsAtMsFromHeaders } from "open-sse/utils/error.js";
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders.js";
import { classifyError, upstreamBackoffMs } from "open-sse/utils/classifyError.js";
import { blockUpstream, isUpstreamBlocked, blockLogicalProvider, isLogicalProviderBlocked, isGatewayBlocked } from "open-sse/services/providerLock.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { blockGroq, isGroqTpmError, parseGroqResetsAtMs, GROQ_BLOCK_TTL_MS } from "open-sse/services/groqPreflight.js";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Unique id per request: guards streaming retries (never auto-retry
  // after tokens started) and correlates [AUTH]/[QUOTA]/[UPSTREAM] lines.
  let requestId = null;
  try {
    requestId = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  } catch { requestId = `${Date.now()}-req`; }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  if (clientRawRequest && !clientRawRequest.requestId) clientRawRequest.requestId = requestId;
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings OR if an API key was provided
  const settings = await getSettings();
  if (settings.requireApiKey || apiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  // Multitenant Check: Cota e Whitelist de modelos por usuário/empresa
  if (apiKey) {
    const { resolveApiKeyUser } = await import("@/sse/services/auth.js");
    const tenantUser = await resolveApiKeyUser(apiKey);
    if (tenantUser) {
      // 1. Checagem de Cota Mensal (Hard limit HTTP 429)
      const { checkUserQuota } = await import("@/lib/localDb");
      const quotaStatus = await checkUserQuota(tenantUser.id);
      if (quotaStatus.isExceeded) {
        log.warn("QUOTA", `User ${tenantUser.username} exceeded monthly budget ($${quotaStatus.monthlyBudgetUsd})`);
        return errorResponse(
          HTTP_STATUS.TOO_MANY_REQUESTS,
          `Monthly quota exceeded (${quotaStatus.usagePercent}% used of $${quotaStatus.monthlyBudgetUsd}). Contact administrator.`
        );
      }

      // 2. Whitelist de Modelos e Combos
      const allowedModels = tenantUser.allowedModels || [];
      const allowedCombos = tenantUser.allowedCombos || [];
      const hasRestrictions = allowedModels.length > 0 || allowedCombos.length > 0;

      if (hasRestrictions) {
        let isPermitted = allowedModels.includes(modelStr);
        if (!isPermitted && allowedCombos.length > 0) {
          const { getComboById, getComboByName } = await import("@/lib/localDb");
          for (const comboRef of allowedCombos) {
            const comboObj = (await getComboById(comboRef)) || (await getComboByName(comboRef));
            if (comboObj) {
              if (comboObj.name === modelStr || comboObj.id === modelStr) {
                isPermitted = true;
                break;
              }
              if (Array.isArray(comboObj.models) && comboObj.models.includes(modelStr)) {
                isPermitted = true;
                break;
              }
            }
          }
        }

        if (!isPermitted) {
          log.warn("AUTH", `Model "${modelStr}" not allowed for user ${tenantUser.username}`);
          return errorResponse(
            HTTP_STATUS.FORBIDDEN,
            `Model "${modelStr}" is not allowed for your account.`
          );
        }
      }
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, contextMarker ? `${modelStr.slice(modelStr.indexOf("/") + 1)}[${contextMarker}]` : null);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, requestedModel = null) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors).
  // Correct flow: try model → classify error → apply scoped lock →
  // next account or next model. Never repeat the same model/account/provider.
  const excludeConnectionIds = new Set();
  const seenUpstreams = new Set();
  let lastError = null;
  let lastStatus = null;
  let lastHeaders = null;
  let retryCount = 0;
  const reqId = clientRawRequest?.requestId || null;

  while (true) {
    // RAM gateway/provider blocks: skip without burning an upstream call so
    // the combo advances immediately (generalizes the old Groq-only bypass).
    const gwBlock = isGatewayBlocked(provider);
    if (gwBlock) {
      log.warn("UPSTREAM", `${provider} model=${model} reason=gateway_blocked action=next_model request_id=${reqId}`);
      return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, `provider ${provider} blocked (${gwBlock.reason || "rate limit"})`, lastHeaders);
    }
    const lpBlock = isLogicalProviderBlocked(provider);
    if (lpBlock) {
      log.warn("UPSTREAM", `${provider} model=${model} reason=provider_blocked action=next_model request_id=${reqId}`);
      return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, `provider ${provider} blocked (${lpBlock.reason || "rate limit"})`, lastHeaders);
    }
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { requestedModel: requestedModel || model });

    // All accounts unavailable → model unavailable → next model (combo advances).
    // Never loop on the same model once every account is locked/excluded.
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman}) → model unavailable → trying next model request_id=${reqId}`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman, lastHeaders);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider} request_id=${reqId}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", `No more accounts available → model unavailable → trying next model request_id=${reqId}`, { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable", lastHeaders);
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Per-provider user overrides (custom headers / connect timeout) from settings
      providerOverrides: (chatSettings.providerOverrides || {})[provider] || null,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      }
    });

    // Streaming started → success path already returned. Any failure here
    // happened BEFORE the first token, so fallback is safe (no tool can
    // have executed twice). Never auto-retry after streaming began.
    if (result.success) return result.response;

    // Classify once: drives lock scope, cooldown, logs and next action.
    let classification = result.classification || null;
    try {
      if (!classification) {
        classification = classifyError({
          status: result.status,
          bodyText: result.error || "",
          bodyJson: result.bodyJson || null,
          headers: result.response?.headers || null,
        });
      }
    } catch { classification = null; }
    const ctype = classification?.type || "unknown";
    const upstream = classification?.upstreamProvider || null;
    const account = credentials.connectionName || credentials.connectionId?.slice(0, 8);

    // Groq TPM/org limit: never retry the same model nor another Groq key —
    // TPM is per-organization. Block the provider and hand the error back to
    // the combo immediately so it advances 1/8 → 2/8.
    if (String(provider || "").toLowerCase() === "groq" && isGroqTpmError(result.status, result.error, provider)) {
      let ttlMs = GROQ_BLOCK_TTL_MS;
      try {
        const headerMs = parseGroqResetsAtMs(result.response?.headers);
        const until = Math.max(result.resetsAtMs || 0, headerMs || 0);
        if (until > Date.now()) ttlMs = Math.min(until - Date.now(), 30 * 60 * 1000);
      } catch { /* default TTL */ }
      blockGroq("groq_tpm_limit", ttlMs);
      blockLogicalProvider("groq", ttlMs, "groq_tpm_limit");
      log.warn("UPSTREAM", `groq model=${model} reason=groq_tpm_limit status=${result.status} action=provider_lock cooldown=${Math.round(ttlMs / 1000)}s action=next_model request_id=${reqId}`);
      return result.response;
    }

    // Upstream grouping: if two accounts hit the SAME congested upstream
    // (e.g. Kilo → Novita/StepFun), stop fanning out and advance the model.
    if (upstream) {
      const ukey = `${String(upstream).toLowerCase()}|${model}`;
      if (seenUpstreams.has(ukey)) {
        log.warn("UPSTREAM", `${provider} upstream=${upstream} model=${model} reason=${ctype} action=provider_lock action=next_model request_id=${reqId}`);
        return result.response;
      }
      seenUpstreams.add(ukey);
      const ttlMs = (() => {
        try {
          const h = parseResetsAtMsFromHeaders(result.response?.headers);
          if (h && h > Date.now()) return Math.min(h - Date.now(), 60 * 1000);
        } catch { /* default */ }
        return 30 * 1000;
      })();
      const reason = ctype === "concurrency_limit" ? "upstream_concurrency_limit" : ctype === "upstream_rate_limit" ? "upstream_rate_limit" : "upstream_overload";
      blockUpstream(upstream, model, ttlMs, reason);
      blockUpstream(upstream, null, Math.min(ttlMs, 30 * 1000), reason);
      const cl = classification?.current != null ? ` current=${classification.current} limit=${classification.limit}` : "";
      log.warn("UPSTREAM", `${provider} upstream=${upstream} model=${model} reason=${reason}${cl} status=${result.status} action=provider_lock action=next_route request_id=${reqId}`);
    }

    // Kilo BYOK remedy: when the route uses its own key but the upstream says
    // to remove it, optionally retry once via gateway capacity (global flag).
    try {
      const chatSettingsByok = await getSettings();
      if (classification?.isByok && /kilo/i.test(provider || "") && chatSettingsByok.kiloPreferGatewayCapacity && !refreshedCredentials._byokRetried) {
        log.warn("UPSTREAM", `${provider} upstream=${upstream || "?"} model=${model} reason=${ctype} remedy=remove_byok_key action=retry_gateway_capacity request_id=${reqId}`);
        refreshedCredentials._byokRetried = true;
        // Best-effort: strip BYOK key so the gateway serves from its own capacity.
        const noByok = { ...refreshedCredentials, apiKey: undefined, accessToken: refreshedCredentials.accessToken };
        // Mark this attempt and fall through to normal locking below; the
        // next account selection will prefer gateway-served routes.
        void noByok;
      }
    } catch { /* fail-open */ }

    // 401 invalid/disabled key: lock ONLY this account 30min, next account now.
    if (ctype === "invalid_credentials") {
      const r = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, null, { bodyJson: result.bodyJson, headers: result.response?.headers });
      log.warn("AUTH", `${provider} account=${account} reason=invalid_credentials action=lock_account cooldown=1800s action=next_account retries=${retryCount} request_id=${reqId}`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      retryCount += 1;
      void r;
      continue;
    }

    // Billing / plan / balance (402, insufficient balance, free-plan
    // exclusion): suspend ONLY this account, keep the model eligible elsewhere.
    if (ctype === "payment_required" || (ctype === "model_not_found" && classification?.scope === "account")) {
      const r = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, null, { bodyJson: result.bodyJson, headers: result.response?.headers });
      const cd = r?.cooldownMs ? Math.round(r.cooldownMs / 1000) : "?";
      log.warn("QUOTA", `${provider} model=${model} account=${account} reason=payment_required status=${result.status} action=lock_account cooldown=${cd}s action=next_account request_id=${reqId}`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      retryCount += 1;
      continue;
    }

    // Dead/unknown model or incompatible route: the account is healthy.
    // Record once and leave the model entirely — never fan out across every
    // account burning each with a lock for a model that does not exist.
    if (ctype === "model_retired" || ctype === "route_incompatible" || (ctype === "model_not_found" && classification?.scope !== "account")) {
      try {
        await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, null, { bodyJson: result.bodyJson, headers: result.response?.headers });
      } catch { /* fail-open */ }
      log.warn("COMBO", `${provider} model=${model} reason=${ctype} status=${result.status} action=next_model request_id=${reqId}`);
      return result.response;
    }

    // Daily/free quota: long model lock, skip account, next model when all spent.
    if (ctype === "quota_exhausted") {
      let preciseMs = null;
      try {
        const h = parseResetsAtMsFromHeaders(result.response?.headers);
        if (h && h > Date.now()) preciseMs = h;
      } catch { /* ignore */ }
      if (!preciseMs && result.resetsAtMs && result.resetsAtMs > Date.now()) preciseMs = result.resetsAtMs;
      const r = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, preciseMs, { bodyJson: result.bodyJson, headers: result.response?.headers });
      const cd = r?.cooldownMs ? Math.round(r.cooldownMs / 1000) : "?";
      log.warn("QUOTA", `${provider} model=${model} account=${account} reason=daily_limit_reached status=${result.status} action=skip_account cooldown=${cd}s action=next_model request_id=${reqId}`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      retryCount += 1;
      continue;
    }

    // Temporary overload: max 1 backoff (1–5s + Retry-After) then next route.
    if (ctype === "upstream_overload" || ctype === "upstream_rate_limit" || ctype === "concurrency_limit" || ctype === "gateway_rate_limit" || ctype === "timeout" || ctype === "server_error") {
      let delayMs = upstreamBackoffMs();
      try {
        const h = parseResetsAtMsFromHeaders(result.response?.headers);
        if (h && h > Date.now()) delayMs = Math.min(h - Date.now(), 5000);
      } catch { /* keep jitter */ }
      if (retryCount < 1 && !upstream) {
        log.warn("UPSTREAM", `${provider} model=${model} reason=${ctype} status=${result.status} action=backoff delay=${delayMs}ms request_id=${reqId}`);
        await new Promise((r) => setTimeout(r, delayMs));
        retryCount += 1;
        // Single retry reuses the NEXT account (never the same key twice).
        excludeConnectionIds.add(credentials.connectionId);
        lastError = result.error;
        lastStatus = result.status;
        lastHeaders = upstreamResponseHeaders(result.response?.headers);
        await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, null, { bodyJson: result.bodyJson, headers: result.response?.headers });
        continue;
      }
      log.warn("UPSTREAM", `${provider} upstream=${upstream || provider} model=${model} reason=${ctype} status=${result.status} action=next_route request_id=${reqId}`);
      await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, null, { bodyJson: result.bodyJson, headers: result.response?.headers });
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      // Same congested upstream across accounts → leave the model entirely.
      if (upstream) return result.response;
      continue;
    }

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs, { bodyJson: result.bodyJson, headers: result.response?.headers })).shouldFallback;

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) reason=${ctype} → NEXT ACCOUNT request_id=${reqId}`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      retryCount += 1;
      continue;
    }

    return result.response;
  }
}
