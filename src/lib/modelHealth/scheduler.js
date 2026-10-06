// Periodic conservative re-verification of model health.
// Default OFF (settings.modelHealth.enabled=false). When enabled, re-tests
// only entries past nextRetry, capped per run, concurrency-bounded.
// Fail-open: any error stops the tick, never the server.
import { MODEL_HEALTH_DEFAULTS } from "open-sse/config/modelHealthConfig.js";

let timer = null;
let running = false;
const state = { started: false, lastRun: null, lastResult: null, lastError: null };

export function getSchedulerState() {
  return { ...state };
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const { getSettings } = await import("@/lib/db/index.js");
    const settings = (await getSettings().catch(() => ({}))) || {};
    const mh = settings.modelHealth || {};
    if (mh.enabled !== true) {
      state.lastResult = "skipped (disabled)";
      return;
    }
    const { getAllModelHealth } = await import("@/lib/db/index.js");
    const all = (await getAllModelHealth().catch(() => ({}))) || {};
    const now = Date.now();
    const due = Object.values(all).filter(
      (e) => e && typeof e === "object" && e.status !== "active" && e.provider && e.model && e.model !== "__all"
        && (!e.nextRetry || new Date(e.nextRetry).getTime() <= now),
    );
    // Permanent errors are rare by construction (nextRetry 7d); still cap.
    const batch = due.slice(0, 10);
    if (batch.length === 0) {
      state.lastRun = new Date().toISOString();
      state.lastResult = "no due candidates";
      return;
    }
    const { pingModelByKind } = await import("@/app/api/models/test/ping.js");
    const { recordModelHealth } = await import("./service.js");
    const { classifyError } = await import("open-sse/utils/classifyError.js");
    const concurrency = Math.max(1, Math.min(4, mh.concurrencyPerProvider || MODEL_HEALTH_DEFAULTS.concurrencyPerProvider));
    let cursor = 0;
    let okCount = 0;
    const workers = Array.from({ length: Math.min(concurrency, batch.length) }, async () => {
      while (cursor < batch.length) {
        const entry = batch[cursor++];
        const modelStr = `${entry.provider}/${entry.model}`;
        let r;
        try {
          r = await pingModelByKind(modelStr, "llm");
        } catch (e) {
          r = { ok: false, status: 0, error: String(e?.message || e).slice(0, 300), latencyMs: null };
        }
        try {
          if (r.ok) {
            okCount++;
            await recordModelHealth({
              connectionId: entry.connectionId || "routing",
              provider: entry.provider, model: entry.model,
              ok: true, statusCode: r.status || 200, reason: "ok", scope: "model",
              latencyMs: r.latencyMs ?? null,
            });
          } else {
            let reason = "probe_failed";
            let scope = "model";
            try {
              const c = classifyError({ status: r.status || 0, bodyText: r.error || "" });
              if (c?.type) {
                reason = c.type === "model_retired" ? "model_retired"
                  : c.type === "payment_required" ? "payment_required"
                  : c.type === "model_not_found" ? "model_not_found"
                  : c.type === "route_incompatible" ? "route_incompatible"
                  : c.type === "invalid_credentials" ? "invalid_credentials"
                  : c.type === "quota_exhausted" ? "quota_exhausted" : "probe_failed";
                scope = c.scope || "model";
              }
            } catch { /* keep defaults */ }
            await recordModelHealth({
              connectionId: entry.connectionId || "routing",
              provider: entry.provider, model: entry.model,
              ok: false, statusCode: r.status || 0, reason, scope,
              latencyMs: r.latencyMs ?? null, errorText: r.error,
            });
          }
        } catch { /* fail-open per entry */ }
      }
    });
    await Promise.all(workers);
    state.lastRun = new Date().toISOString();
    state.lastResult = `tested ${batch.length}, reactivated ${okCount}`;
    state.lastError = null;
  } catch (e) {
    state.lastError = String(e?.message || e).slice(0, 300);
  } finally {
    running = false;
  }
}

export function startModelHealthScheduler() {
  if (state.started) return;
  state.started = true;
  const boot = async () => {
    try {
      const { getSettings } = await import("@/lib/db/index.js");
      const settings = (await getSettings().catch(() => ({}))) || {};
      const interval = Number(settings?.modelHealth?.checkIntervalMs) || MODEL_HEALTH_DEFAULTS.checkIntervalMs;
      timer = setInterval(() => {
        tick().catch(() => {});
      }, Math.max(5 * 60 * 1000, interval));
      if (timer?.unref) timer.unref();
    } catch {
      timer = setInterval(() => {
        tick().catch(() => {});
      }, MODEL_HEALTH_DEFAULTS.checkIntervalMs);
      if (timer?.unref) timer.unref();
    }
    // First tick delayed: let the server boot and serve first requests.
    setTimeout(() => {
      tick().catch(() => {});
    }, 60 * 1000);
  };
  boot().catch(() => {});
}

export function stopModelHealthScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  state.started = false;
}
