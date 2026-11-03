import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/db/index.js";
import { startWebshareSyncScheduler, stopWebshareSyncScheduler } from "@/lib/proxyPools/webshareSyncScheduler.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_INTERVAL_MINUTES = 60;

function normalizeConfig(body = {}) {
  const config = {
    apiKey: typeof body.apiKey === "string" ? body.apiKey.trim() : "",
    mode: body.mode === "backbone" ? "backbone" : "direct",
    pageSize: Math.min(Math.max(Number(body.pageSize) || 100, 1), 100),
    planId: typeof body.planId === "string" ? body.planId.trim() || null : null,
    autoReplaceOnWebshare: body.autoReplaceOnWebshare !== false,
    removeDeadFrom9Router: body.removeDeadFrom9Router !== false,
    autoSync: body.autoSync === true,
    syncIntervalMinutes: Math.min(Math.max(Number(body.syncIntervalMinutes) || DEFAULT_INTERVAL_MINUTES, 1), 1440),
  };

  if (config.apiKey) {
    config.apiKey = config.apiKey.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
  }

  return config;
}

export async function GET() {
  try {
    const settings = await getSettings();
    const config = settings?.webshareSync || {};

    return NextResponse.json({
      ...config,
      apiKey: "",
    });
  } catch (error) {
    console.error("[Webshare Config] GET failed:", error);
    return NextResponse.json({ error: "Failed to load Webshare config" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const config = normalizeConfig(body);

    if (config.apiKey && config.apiKey.length < 10) {
      return NextResponse.json({ error: "Webshare API key is too short" }, { status: 400 });
    }

    const updates = {
      "webshareSync.apiKey": config.apiKey,
      "webshareSync.mode": config.mode,
      "webshareSync.pageSize": config.pageSize,
      "webshareSync.planId": config.planId,
      "webshareSync.autoReplaceOnWebshare": config.autoReplaceOnWebshare,
      "webshareSync.removeDeadFrom9Router": config.removeDeadFrom9Router,
      "webshareSync.autoSync": config.autoSync,
      "webshareSync.syncIntervalMinutes": config.syncIntervalMinutes,
    };

    const settings = await updateSettings(updates);

    if (config.autoSync && config.apiKey) {
      if (!global.__webshareScheduler?.intervalHandle) {
        startWebshareSyncScheduler();
      }
    } else {
      stopWebshareSyncScheduler();
    }

    return NextResponse.json({
      success: true,
      autoSync: config.autoSync,
      nextSyncAt: config.autoSync ? new Date(Date.now() + config.syncIntervalMinutes * 60000).toISOString() : null,
    });
  } catch (error) {
    console.error("[Webshare Config] POST failed:", error);
    return NextResponse.json({ error: error.message || "Failed to save Webshare config" }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    const config = normalizeConfig(body);

    const updates = {};
    if (typeof body.apiKey === "string" && body.apiKey.trim()) {
      updates["webshareSync.apiKey"] = config.apiKey;
    }
    if (body.autoSync !== undefined) updates["webshareSync.autoSync"] = config.autoSync;
    if (body.syncIntervalMinutes !== undefined) {
      updates["webshareSync.syncIntervalMinutes"] = config.syncIntervalMinutes;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No valid updates provided" }, { status: 400 });
    }

    const settings = await updateSettings(updates);

    if (config.autoSync && config.apiKey) {
      startWebshareSyncScheduler();
    } else {
      stopWebshareSyncScheduler();
    }

    return NextResponse.json({
      success: true,
      autoSync: config.autoSync,
      nextSyncAt: config.autoSync ? new Date(Date.now() + config.syncIntervalMinutes * 60000).toISOString() : null,
    });
  } catch (error) {
    console.error("[Webshare Config] PATCH failed:", error);
    return NextResponse.json({ error: error.message || "Failed to update Webshare config" }, { status: 500 });
  }
}