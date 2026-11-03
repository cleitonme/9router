import { NextResponse } from "next/server";
import {
  getCachedCatalog,
  isCatalogProvider,
  refreshProviderCatalog,
} from "@/lib/services/providerCatalog";

export const dynamic = "force-dynamic";

// GET /api/providers/[id]/catalog - cached live catalogue snapshot
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    if (!isCatalogProvider(id)) {
      return NextResponse.json({ error: "Provider has no live catalogue" }, { status: 400 });
    }
    const catalog = await getCachedCatalog(id);
    return NextResponse.json({ provider: id, catalog });
  } catch (error) {
    console.error("[ProviderCatalog] GET failed:", error);
    return NextResponse.json({ error: "Failed to read provider catalogue" }, { status: 500 });
  }
}

// POST /api/providers/[id]/catalog - force a live refresh
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    if (!isCatalogProvider(id)) {
      return NextResponse.json({ error: "Provider has no live catalogue" }, { status: 400 });
    }
    const body = await request.json().catch(() => ({}));
    const catalog = await refreshProviderCatalog(id, {
      force: true,
      connectionId: body?.connectionId || null,
    });
    const ok = !catalog.error;
    return NextResponse.json({ provider: id, ok, catalog }, { status: ok ? 200 : 502 });
  } catch (error) {
    console.error("[ProviderCatalog] POST failed:", error);
    return NextResponse.json({ error: "Failed to refresh provider catalogue" }, { status: 500 });
  }
}
