import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = await getSettings();
    const webshareConfig = settings?.webshareSync || {};
    
    const status = {
      configured: !!webshareConfig?.apiKey?.trim(),
      autoSync: webshareConfig?.autoSync || false,
      syncIntervalMinutes: webshareConfig?.syncIntervalMinutes || 60,
      lastSyncAt: webshareConfig?.lastSyncAt || null,
      syncCount: webshareConfig?.stats?.syncCount || 0,
      totalPools: webshareConfig?.stats?.totalPools || 0,
      nextSyncAt: webshareConfig?.autoSync 
        ? new Date(Date.now() + (webshareConfig?.syncIntervalMinutes || 60) * 60000).toISOString()
        : null,
    };

    return NextResponse.json({ success: true, status });
  } catch (error) {
    console.error("[Webshare Status] GET failed:", error);
    return NextResponse.json({ error: error.message || "Failed to get Webshare status" }, { status: 500 });
  }
}