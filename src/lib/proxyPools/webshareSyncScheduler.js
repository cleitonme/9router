import { getSettings, updateSettings } from "@/lib/db/index.js";
import { getProxyPools, createProxyPool, updateProxyPool } from "@/models";

const g = global.__webshareScheduler ??= {
  intervalHandle: null,
  lastSyncTimestamp: 0,
  syncInProgress: false,
};

const WEBSHARE_SYNC_URL = "https://proxy.webshare.io/api/v2/proxy/list";
const DEFAULT_SYNC_INTERVAL_MINUTES = 60;
const DEAD_PROXY_DETECTION_HOURS = 6;

export async function getWebshareSyncConfig() {
  const settings = await getSettings();
  return settings?.webshareSync || {
    apiKey: "",
    autoSync: false,
    syncIntervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES,
  };
}

export async function syncWebsharePools(options = {}) {
  if (g.syncInProgress) return { success: false, error: "Sync already in progress" };

  g.syncInProgress = true;
  const startTime = Date.now();

  try {
    const config = await getWebshareSyncConfig();
    const apiKey = options.apiKey || config.apiKey || process.env.WEBSHARE_API_KEY;

    if (!apiKey?.trim()) {
      return { success: false, error: "Webshare API key not configured" };
    }

    const pageSize = Math.min(Math.max(Number(config.pageSize) || 100, 1), 100);
    const mode = config.mode || "direct";
    const planId = config.planId;
    const autoReplace = config.autoReplaceOnWebshare !== false;
    const removeDead = config.removeDeadFrom9Router !== false;

    const result = await performWebshareSync({
      apiKey,
      mode,
      pageSize,
      planId,
      autoReplace,
      removeDead,
    });

    const endTime = Date.now();
    const durationMs = endTime - startTime;

    const now = new Date().toISOString();
    const prevSyncCount = config.stats?.syncCount || 0;
    await updateSettings({
      webshareSync: {
        lastSyncAt: now,
        syncCount: prevSyncCount + 1,
        syncDurationMs: durationMs,
        lastSyncResult: {
          ...result,
          completedAt: now,
          durationMs,
        },
      },
    });

    return { success: true, ...result };
  } catch (err) {
    console.error("[WebshareSync] Sync failed:", err.message || err);
    return { success: false, error: err.message || String(err) };
  } finally {
    g.syncInProgress = false;
  }
}

async function performWebshareSync({ apiKey, mode, pageSize, planId, autoReplace, removeDead }) {
  let created = 0;
  let skipped = 0;
  let deadDetected = 0;
  let replacedOnWebshare = 0;
  let removedFrom9Router = 0;
  let disabledIn9Router = 0;

  const existingPools = await getProxyPools();
  const websharePools = existingPools.filter((p) => p.name.startsWith("Webshare "));
  const existingUrls = new Set(existingPools.map((p) => p.proxyUrl?.toLowerCase() || ""));

  for (const pool of websharePools) {
    if (!pool.isActive && !pool.quarantineUntil) continue;

    const ageHours = pool.lastTestedAt ? (Date.now() - new Date(pool.lastTestedAt).getTime()) / 3600000 : 999;
    if (ageHours > DEAD_PROXY_DETECTION_HOURS && pool.isActive) {
      await updateProxyPool(pool.id, { isActive: false });
      disabledIn9Router += 1;
    }
  }

  if (websharePools.length > 0 && autoReplace) {
    const deadIps = websharePools
      .filter((p) => !p.isActive || p.testStatus === "error")
      .map((p) => {
        const match = p.name.match(/Webshare\s+([0-9.]+):/i) || p.proxyUrl?.match(/@([0-9.]+):/);
        return match ? match[1] : null;
      })
      .filter(Boolean);

    if (deadIps.length > 0) {
      try {
        const replaceRes = await fetch("https://proxy.webshare.io/api/v3/proxy/replace/", {
          method: "POST",
          headers: {
            Authorization: `Token ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            to_replace: {
              type: "ip_address",
              ip_addresses: deadIps,
            },
            replace_with: [
              {
                type: "any",
                count: deadIps.length,
              },
            ],
            dry_run: false,
          }),
        });

        if (replaceRes.ok) {
          replacedOnWebshare = deadIps.length;
        }
      } catch (err) {
        console.warn("[WebshareSync] Replace failed:", err.message);
      }
    }
  }

  let page = 1;
  const fetchPageSize = 100;

  while (created + skipped < pageSize) {
    const planParam = planId ? `&plan_id=${encodeURIComponent(planId)}` : "";
    const url = `${WEBSHARE_SYNC_URL}?mode=${mode}&page=${page}&page_size=${fetchPageSize}${planParam}`;

    const res = await fetch(url, {
      headers: { Authorization: `Token ${apiKey}` },
    });

    if (!res.ok) {
      return { success: false, error: `Webshare API error: HTTP ${res.status}` };
    }

    const data = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];

    if (results.length === 0) break;

    for (const item of results) {
      const auth = item.username && item.password ? `${encodeURIComponent(item.username)}:${encodeURIComponent(item.password)}@` : "";
      const proxyUrl = `http://${auth}${item.proxy_address}:${item.port}`;
      const urlLower = proxyUrl.toLowerCase();

      if (existingUrls.has(urlLower)) {
        skipped += 1;
        continue;
      }

      const country = item.country_code ? ` [${item.country_code}]` : "";
      const city = item.city_name ? ` - ${item.city_name}` : "";
      const name = `Webshare ${item.proxy_address}:${item.port}${country}${city}`;

      await createProxyPool({
        name,
        proxyUrl,
        noProxy: "",
        countryCode: item.country_code || null,
        cityName: item.city_name || null,
        planId: planId || item.plan_id || null,
        isActive: item.valid !== false,
        strictProxy: false,
        type: "http",
      });

      existingUrls.add(urlLower);
      created += 1;
    }

    if (!data.next || results.length < fetchPageSize) break;
    page += 1;
  }

  if (removeDead) {
    for (const pool of websharePools) {
      const stillExists = existingUrls.has(pool.proxyUrl?.toLowerCase() || "");
      if (!stillExists && !pool.quarantineUntil) {
        await updateProxyPool(pool.id, { isActive: false });
        removedFrom9Router += 1;
      }
    }
  }

  return {
    created,
    skipped,
    deadDetected: websharePools.filter((p) => !p.isActive).length,
    replacedOnWebshare,
    removedFrom9Router,
    disabledIn9Router,
  };
}

let schedulerTimer = null;

export function startWebshareSyncScheduler() {
  if (schedulerTimer) return schedulerTimer;

  const startScheduler = async () => {
    const config = await getWebshareSyncConfig();
    if (!config?.autoSync || !config?.apiKey?.trim()) return null;

    const intervalMs = (config?.syncIntervalMinutes || DEFAULT_SYNC_INTERVAL_MINUTES) * 60 * 1000;

    console.log(`[WebshareSync] Scheduler started (interval: ${config.syncIntervalMinutes}m)`);

    schedulerTimer = setInterval(() => {
      syncWebsharePools().catch((err) => console.error("[WebshareSync] Scheduled sync failed:", err.message || err));
    }, intervalMs);

    if (schedulerTimer.unref) schedulerTimer.unref();

    return schedulerTimer;
  };

  startScheduler().catch((err) => console.error("[WebshareSync] Failed to start scheduler:", err.message || err));

  return schedulerTimer;
}

export function stopWebshareSyncScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log("[WebshareSync] Scheduler stopped");
  }
}

export function isWebshareSyncSchedulerRunning() {
  return !!schedulerTimer;
}

export function getSyncSchedulerStatus() {
  const config = global?.__webshareScheduler;
  return {
    running: isWebshareSyncSchedulerRunning(),
    lastSync: g.lastSyncTimestamp,
    syncInProgress: g.syncInProgress,
  };
}