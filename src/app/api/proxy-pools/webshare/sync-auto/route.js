import { NextResponse } from "next/server";
import { syncWebsharePools, getWebshareSyncConfig } from "@/lib/proxyPools/webshareSyncScheduler.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const config = await getWebshareSyncConfig();
    const apiKey = config?.apiKey || process.env.WEBSHARE_API_KEY;

    if (!apiKey?.trim()) {
      return NextResponse.json({ error: "Webshare API key not configured. Set it in Settings → Webshare Sync." }, { status: 401 });
    }

    const result = await syncWebsharePools({ apiKey });

    if (result.success) {
      return NextResponse.json({
        success: true,
        ...result,
        message: `Sync completed. Created: ${result.created}, Dead detected: ${result.deadDetected}`,
      });
    } else {
      return NextResponse.json({ error: result.error || "Sync failed" }, { status: 500 });
    }
  } catch (error) {
    console.error("[Webshare Sync] POST failed:", error);
    return NextResponse.json({ error: error.message || "Failed to sync Webshare proxies" }, { status: 500 });
  }
}