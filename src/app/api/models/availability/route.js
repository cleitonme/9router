import { NextResponse } from "next/server";
import {
  getProviderConnections,
  updateProviderConnection,
  getAllModelHealth,
  removeModelHealthEntry,
} from "@/lib/localDb";

const MODEL_LOCK_PREFIX = "modelLock_";

function getActiveModelLocks(connection) {
  const now = Date.now();
  return Object.entries(connection)
    .filter(([key, value]) => key.startsWith(MODEL_LOCK_PREFIX) && value)
    .map(([key, value]) => ({
      key,
      model: key.slice(MODEL_LOCK_PREFIX.length) || "__all",
      until: value,
      active: new Date(value).getTime() > now,
    }))
    .filter((lock) => lock.active);
}

export async function GET() {
  try {
    const connections = await getProviderConnections();
    const models = [];

    for (const connection of connections) {
      const locks = getActiveModelLocks(connection);
      for (const lock of locks) {
        models.push({
          provider: connection.provider,
          model: lock.model,
          status: "cooldown",
          until: lock.until,
          connectionId: connection.id,
          connectionName: connection.name || connection.email || connection.id,
          lastError: connection.lastError || null,
        });
      }

      if (locks.length === 0 && connection.testStatus === "unavailable") {
        models.push({
          provider: connection.provider,
          model: "__all",
          status: "unavailable",
          connectionId: connection.id,
          connectionName: connection.name || connection.email || connection.id,
          lastError: connection.lastError || null,
        });
      }
    }

    // Durable per-account/per-model health (kv scope "modelHealth").
    // Fail-open: kv errors must not break the availability endpoint.
    try {
      const health = (await getAllModelHealth()) || {};
      const now = Date.now();
      for (const [key, entry] of Object.entries(health)) {
        if (!entry || typeof entry !== "object") continue;
        if (entry.status === "active") continue;
        if (entry.nextRetry && new Date(entry.nextRetry).getTime() <= now) continue;
        models.push({
          provider: entry.provider || null,
          model: entry.model || "__all",
          status: entry.status || "cooldown",
          reason: entry.reason || null,
          scope: entry.scope || null,
          statusCode: entry.statusCode ?? null,
          lastCheck: entry.lastCheck || null,
          nextRetry: entry.nextRetry || null,
          consecutiveFailures: entry.consecutiveFailures || 0,
          connectionId: entry.connectionId || null,
          connectionName:
            (connections.find((c) => c.id === entry.connectionId)?.name ||
              connections.find((c) => c.id === entry.connectionId)?.email ||
              entry.connectionId) || null,
          lastError: entry.lastError || null,
          healthKey: key,
        });
      }
    } catch { /* fail-open */ }

    return NextResponse.json({
      models,
      unavailableCount: models.length,
    });
  } catch (error) {
    console.error("[API] Failed to get model availability:", error);
    return NextResponse.json(
      { error: "Failed to fetch model availability" },
      { status: 500 },
    );
  }
}

export async function POST(request) {
  try {
    const { action, provider, model, connectionId, healthKey } = await request.json();

    // Manual reactivation of a durable health entry (dashboard button).
    // Removes the kv record so the candidate is eligible again immediately.
    if (action === "clearHealth") {
      if (!healthKey && (!provider || !model)) {
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      }
      const { modelHealthKey } = await import("@/lib/localDb");
      const keys = [];
      if (healthKey) {
        keys.push(healthKey);
      } else {
        const connections = await getProviderConnections({ provider });
        for (const c of connections) {
          if (connectionId && c.id !== connectionId) continue;
          keys.push(modelHealthKey({ connectionId: c.id, provider, model }));
        }
      }
      await Promise.all(keys.map((k) => removeModelHealthEntry(k)));
      return NextResponse.json({ ok: true, cleared: keys.length });
    }

    if (action !== "clearCooldown" || !provider || !model) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const connections = await getProviderConnections({ provider });
    const lockKey = `${MODEL_LOCK_PREFIX}${model}`;

    await Promise.all(
      connections
        .filter((connection) => connection[lockKey])
        .map((connection) =>
          updateProviderConnection(connection.id, {
            [lockKey]: null,
            ...(connection.testStatus === "unavailable"
              ? {
                   testStatus: "active",
                   lastError: null,
                   lastErrorAt: null,
                   backoffLevel: 0,
                 }
              : {}),
          }),
        ),
    );

    // Also clear durable health so manual reactivation is one click.
    try {
      const { modelHealthKey } = await import("@/lib/localDb");
      await Promise.all(
        connections.map((c) => removeModelHealthEntry(modelHealthKey({ connectionId: c.id, provider, model }))),
      );
    } catch { /* fail-open */ }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[API] Failed to clear model cooldown:", error);
    return NextResponse.json(
      { error: "Failed to clear cooldown" },
      { status: 500 },
    );
  }
}
