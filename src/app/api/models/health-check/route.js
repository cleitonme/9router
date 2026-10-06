import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { recordModelHealth, listModelHealth } from "@/lib/modelHealth/service.js";
import { MODEL_HEALTH_DEFAULTS } from "open-sse/config/modelHealthConfig.js";
import { classifyError } from "open-sse/utils/classifyError.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function pingOne(model) {
  const { pingModelByKind } = await import("@/app/api/models/test/ping.js");
  const start = Date.now();
  try {
    const r = await pingModelByKind(model, "llm");
    return { ...r, latencyMs: r.latencyMs ?? Date.now() - start };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, status: 0, error: String(e?.message || e).slice(0, 300) };
  }
}

function reasonFromResult(r) {
  try {
    const c = classifyError({ status: r.status || 0, bodyText: r.error || "" });
    if (c?.type === "model_retired") return { reason: "model_retired", scope: "model" };
    if (c?.type === "payment_required") return { reason: "payment_required", scope: "account" };
    if (c?.type === "model_not_found") return { reason: "model_not_found", scope: c.scope || "model" };
    if (c?.type === "route_incompatible") return { reason: "route_incompatible", scope: "model" };
    if (c?.type === "invalid_credentials") return { reason: "invalid_credentials", scope: "account" };
    if (c?.type === "quota_exhausted") return { reason: "quota_exhausted", scope: "model" };
    return { reason: "probe_failed", scope: "model" };
  } catch {
    return { reason: "probe_failed", scope: "model" };
  }
}

// Manual + scheduled re-verification of models. Works even when the periodic
// scheduler is disabled in settings — this is the dashboard "Testar agora".
// Body: { models?: string[], provider?: string, limit?: number, connectionId?: string }
export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch { body = {}; }

  const settings = await getSettings().catch(() => ({}));
  const mh = settings?.modelHealth || {};
  const concurrency = Math.max(1, Math.min(4, mh.concurrencyPerProvider || MODEL_HEALTH_DEFAULTS.concurrencyPerProvider));
  const limit = Math.max(1, Math.min(20, Number(body.limit) || 10));

  let models = Array.isArray(body.models) ? body.models.filter((m) => typeof m === "string") : [];
  if (models.length === 0) {
    // Default candidates: health entries past nextRetry (optionally provider-filtered).
    try {
      const all = (await listModelHealth()) || {};
      const now = Date.now();
      for (const entry of Object.values(all)) {
        if (!entry || typeof entry !== "object") continue;
        if (body.provider && entry.provider !== body.provider) continue;
        if (entry.status === "active") continue;
        if (entry.nextRetry && new Date(entry.nextRetry).getTime() > now) continue;
        const prov = entry.provider || body.provider;
        const mod = entry.model;
        if (prov && mod && mod !== "__all") models.push(`${prov}/${mod}`);
        if (models.length >= limit) break;
      }
    } catch { /* fail-open */ }
  }
  models = [...new Set(models)].slice(0, limit);

  if (models.length === 0) {
    return NextResponse.json({ ok: true, tested: 0, results: [], note: "no due candidates" });
  }

  const connectionId = typeof body.connectionId === "string" ? body.connectionId : "routing";
  const results = [];
  // Bounded worker pool: never hammer upstreams.
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, models.length) }, async () => {
    while (cursor < models.length) {
      const modelStr = models[cursor++];
      const slash = modelStr.indexOf("/");
      const provider = slash > 0 ? modelStr.slice(0, slash) : body.provider || null;
      const model = slash > 0 ? modelStr.slice(slash + 1) : modelStr;
      const r = await pingOne(modelStr);
      if (r.ok) {
        await recordModelHealth({
          connectionId, provider, model,
          ok: true, statusCode: r.status || 200, reason: "ok", scope: "model",
          latencyMs: r.latencyMs,
        });
        results.push({ model: modelStr, ok: true, latencyMs: r.latencyMs });
      } else {
        const { reason, scope } = reasonFromResult(r);
        await recordModelHealth({
          connectionId, provider, model,
          ok: false, statusCode: r.status || 0, reason, scope,
          latencyMs: r.latencyMs, errorText: r.error,
        });
        // Never leak prompts/bodies: only code + truncated provider message.
        results.push({ model: modelStr, ok: false, status: r.status || 0, reason, latencyMs: r.latencyMs });
      }
    }
  });
  await Promise.all(workers);

  return NextResponse.json({ ok: true, tested: results.length, results });
}

export async function GET() {
  const settings = await getSettings().catch(() => ({}));
  const mh = settings?.modelHealth || {};
  const { getSchedulerState } = await import("@/lib/modelHealth/scheduler.js");
  return NextResponse.json({
    enabled: mh.enabled === true,
    mode: mh.mode || "observe",
    checkIntervalMs: mh.checkIntervalMs || MODEL_HEALTH_DEFAULTS.checkIntervalMs,
    scheduler: getSchedulerState(),
  });
}
