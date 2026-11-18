// Kiro IDE identity sent on every Kiro / Amazon Q call. Kiro's client-version gate
// (since 2026-11-09; the floor rises to IDE 0.12.291 on 2027-01-15) rejects older
// identities such as `kiro-ide/1.0.0` with "This version of Kiro is no longer
// supported" (#5613). Current stable IDE release per the official update metadata
// (published 2026-11-10):
// https://prod.download.desktop.kiro.dev/stable/metadata-linux-x64-stable.json
export const KIRO_IDE_VERSION = "1.4.154";
export const KIRO_SDK_VERSION = "1.0.0";
export const KIRO_AGENT_OS = "windows";
export const KIRO_AGENT_OS_VERSION = "10.0.26200";
export const KIRO_NODE_VERSION = "22.21.1";

// The IDE uses a different AWS SDK client per API: the streaming client for
// generateAssistantResponse, the runtime client for ListAvailableModels,
// ListAvailableProfiles and GetUsageLimits. Each one names itself in the User-Agent.
export const KIRO_SDK_CLIENTS = {
  streaming: { api: "codewhispererstreaming", metrics: "E" },
  runtime: { api: "codewhispererruntime", metrics: "N,E" },
};

// CreateResponse (/v1/responses) — IDE 1.4.x moved primary chat traffic to this
// surface. The legacy generateAssistantResponse can answer
// 429 USER_REQUEST_RATE_EXCEEDED on accounts that still have quota left (#5631),
// so KiroExecutor keeps it as a fallback, never the default route.
export const KIRO_CREATE_RESPONSE = {
  urlTemplate: "https://runtime.{region}.kiro.dev/v1/responses",
  defaultRegion: "us-east-1",
  // The ACP client identity the IDE uses for this API. The version stays tied to
  // KIRO_IDE_VERSION so the client-version gate (#5613) keeps one source of truth.
  userAgent: `KiroIDE-${KIRO_IDE_VERSION}-KiroIDE/acp-client`,
  agentMode: "vibe",
  rateExceededCode: "USER_REQUEST_RATE_EXCEEDED",
  // One retry absorbs the upstream 1-concurrent-request burst window.
  retryDelayMs: 1500,
  // These credentials are accepted by the legacy Amazon surfaces but rejected by
  // runtime.*.kiro.dev (401/403), so the fallback would only burn quota there.
  unsupportedAuthMethods: new Set(["api_key", "idc", "external_idp"]),
  modeEnvVars: ["NINEROUTER_KIRO_CREATE_RESPONSE", "KIRO_CREATE_RESPONSE"],
};

// AWS region shape accepted before a credential-owned `region` is interpolated
// into an upstream hostname. Anything else (dots, slashes, spaces) would let a
// connection redirect the request — and its bearer token — off-network (SSRF).
export const KIRO_REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;

/** Resolve the CreateResponse mode: "auto" (default), "always" or "off". */
export function resolveKiroCreateResponseMode(env = process.env) {
  const raw = env[KIRO_CREATE_RESPONSE.modeEnvVars[0]] ?? env[KIRO_CREATE_RESPONSE.modeEnvVars[1]];
  const mode = String(raw || "auto").trim().toLowerCase();
  return mode === "always" || mode === "off" ? mode : "auto";
}
