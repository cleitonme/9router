import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/db/index.js";
import { restartWebshareSyncScheduler, stopWebshareSyncScheduler } from "@/lib/proxyPools/webshareSyncScheduler.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_INTERVAL_MINUTES = 60;

function has(body, key) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function sanitizeApiKey(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
}

// Build a partial update map from the request body. Missing keys are left
// untouched, and an empty apiKey is intentionally omitted so a save that does
// not retype the token never wipes the stored one.
function buildUpdates(body = {}) {
  const updates = {};

  if (has(body, "apiKey")) {
    const key = sanitizeApiKey(body.apiKey);
    if (key) updates.apiKey = key;
  }
  if (has(body, "mode")) {
    updates.mode = body.mode === "backbone" ? "backbone" : "direct";
  }
  if (has(body, "pageSize")) {
    updates.pageSize = Math.min(Math.max(Number(body.pageSize) || 100, 1), 100);
  }
  if (has(body, "planId")) {
    updates.planId = typeof body.planId === "string" ? body.planId.trim() || null : null;
  }
  if (has(body, "autoReplaceOnWebshare")) {
    updates.autoReplaceOnWebshare = body.autoReplaceOnWebshare !== false;
  }
  if (has(body, "removeDeadFrom9Router")) {
    updates.removeDeadFrom9Router = body.removeDeadFrom9Router !== false;
  }
  if (has(body, "autoSync")) {
    updates.autoSync = body.autoSync === true;
  }
  if (has(body, "syncIntervalMinutes")) {
    updates.syncIntervalMinutes = Math.min(
      Math.max(Number(body.syncIntervalMinutes) || DEFAULT_INTERVAL_MINUTES, 1),
      1440,
    );
  }

  return updates;
}

// Start/stop based on the persisted config, not the request body: a partial save
// that only flips autoSync must still start the scheduler with the stored key.
function applyScheduler(webshareSync = {}) {
  if (webshareSync.autoSync === true && webshareSync.apiKey?.trim()) {
    restartWebshareSyncScheduler();
  } else {
    stopWebshareSyncScheduler();
  }
}

function buildResponse(webshareSync = {}) {
  const autoSync = webshareSync.autoSync === true;
  const apiKeyConfigured = !!webshareSync.apiKey?.trim();
  const syncIntervalMinutes = webshareSync.syncIntervalMinutes || DEFAULT_INTERVAL_MINUTES;

  return {
    success: true,
    autoSync,
    apiKeyConfigured,
    syncIntervalMinutes,
    nextSyncAt: autoSync && apiKeyConfigured
      ? new Date(Date.now() + syncIntervalMinutes * 60000).toISOString()
      : null,
  };
}

export async function GET() {
  try {
    const settings = await getSettings();
    const config = settings?.webshareSync || {};

    return NextResponse.json({
      ...config,
      apiKey: "",
      apiKeyConfigured: !!config?.apiKey?.trim(),
    });
  } catch (error) {
    console.error("[Webshare Config] GET failed:", error);
    return NextResponse.json({ error: "Failed to load Webshare config" }, { status: 500 });
  }
}

async function handleSave(request) {
  try {
    const body = await request.json();

    if (has(body, "apiKey")) {
      const key = sanitizeApiKey(body.apiKey);
      if (key && key.length < 10) {
        return NextResponse.json({ error: "Webshare API key is too short" }, { status: 400 });
      }
    }

    const updates = buildUpdates(body);
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No valid updates provided" }, { status: 400 });
    }

    const settings = await updateSettings({ webshareSync: updates });
    applyScheduler(settings.webshareSync);

    return NextResponse.json(buildResponse(settings.webshareSync));
  } catch (error) {
    console.error("[Webshare Config] save failed:", error);
    return NextResponse.json({ error: error.message || "Failed to save Webshare config" }, { status: 500 });
  }
}

export async function POST(request) {
  return handleSave(request);
}

export async function PATCH(request) {
  return handleSave(request);
}