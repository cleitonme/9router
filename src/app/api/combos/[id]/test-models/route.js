import { NextResponse } from "next/server";
import { getComboById } from "@/lib/localDb";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { pingModelByKind } from "@/app/api/models/test/ping";

// A combo never needs more than this, and it keeps a caller from turning the
// endpoint into an unbounded upstream-call amplifier. The dashboard probes one
// model per request so live per-model progress stays possible.
const MAX_MODELS = 25;

const cleanModels = (value) => (
  Array.isArray(value)
    ? [...new Set(value.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim()))]
    : []
);

/**
 * POST /api/combos/[id]/test-models
 * id = combo id, or "draft" for models that were not saved yet.
 * Probes the models sequentially to avoid connection saturation, rate-limits
 * and timeouts on combos with many members.
 */
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const requested = cleanModels(body.models);
    const isDraft = !id || id === "draft";

    let models = [];
    let kind = body.kind || "llm";

    if (isDraft) {
      models = requested;
    } else {
      const combo = await getComboById(id);
      if (!combo) {
        return NextResponse.json({ error: "Combo not found" }, { status: 404 });
      }
      if (combo.kind) kind = combo.kind;

      // Only members of this combo may be probed, otherwise the request body
      // would let anyone spend upstream quota on arbitrary model ids.
      const members = (combo.models || []).map(String);
      const memberSet = new Set(members);
      const invalid = requested.find((m) => !memberSet.has(m));
      if (invalid) {
        return NextResponse.json(
          { error: `Model not in combo: ${invalid}` },
          { status: 400 }
        );
      }
      models = requested.length > 0 ? requested : members;
    }

    models = [...new Set(models)].slice(0, MAX_MODELS);

    if (models.length === 0) {
      return NextResponse.json({ error: "No models in combo to test" }, { status: 400 });
    }

    const baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`;
    const results = [];

    for (const model of models) {
      try {
        const res = await pingModelByKind(model, kind, baseUrl);
        results.push({ model, ...res });
      } catch (err) {
        results.push({
          model,
          ok: false,
          latencyMs: 0,
          error: err?.message || "Model test aborted or timed out",
          status: 500,
        });
      }
    }

    const aliveCount = results.filter((r) => r.ok).length;

    return NextResponse.json({
      comboId: id,
      summary: {
        total: results.length,
        alive: aliveCount,
        dead: results.length - aliveCount,
      },
      results,
    });
  } catch (error) {
    console.error("Error testing combo models:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to test combo models" },
      { status: 500 }
    );
  }
}
