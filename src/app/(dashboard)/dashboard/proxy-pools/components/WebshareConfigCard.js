"use client";

import { useState, useCallback } from "react";
import { Button, Input, Toggle, Badge, Card, Modal, ConfirmModal } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

function WebshareConfigCard({ settings, onUpdate, onSync }) {
  const ws = settings?.webshareSync || {};
  
  const [apiKey, setApiKey] = useState(ws.apiKey || "");
  const [mode, setMode] = useState(ws.mode || "direct");
  const [pageSize, setPageSize] = useState(String(ws.pageSize || 100));
  const [planId, setPlanId] = useState(ws.planId || "");
  const [autoReplace, setAutoReplace] = useState(ws.autoReplaceOnWebshare !== false);
  const [removeDead, setRemoveDead] = useState(ws.removeDeadFrom9Router !== false);
  const [autoSync, setAutoSync] = useState(ws.autoSync || false);
  const [syncInterval, setSyncInterval] = useState(String(ws.syncIntervalMinutes || 60));

  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [confirmState, setConfirmState] = useState(null);

  const notify = useNotificationStore();

  const handleSaveConfig = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/proxy-pools/webshare/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey,
          mode,
          pageSize: Number(pageSize),
          planId: planId || undefined,
          autoReplaceOnWebshare: autoReplace,
          removeDeadFrom9Router: removeDead,
          autoSync,
          syncIntervalMinutes: Number(syncInterval),
        }),
      });

      const data = await res.json();

      if (res.ok) {
        notify.success("Webshare configuration saved");
        onUpdate?.();
      } else {
        notify.error(data.error || "Failed to save configuration");
      }
    } catch (err) {
      notify.error("Error saving configuration");
    } finally {
      setLoading(false);
    }
  };

  const handleSyncNow = () => {
    setConfirmState({
      title: "Sync Webshare Proxies Now?",
      message: "This will:\n- Test all existing Webshare proxies\n- Replace dead proxies on Webshare (if enabled)\n- Add new proxies to the pool\n- Deactivate/remove dead proxies\n\nEstimated time: 1-5 minutes depending on pool size.",
      onConfirm: async () => {
        setConfirmState(null);
        setSyncing(true);
        try {
          const res = await fetch("/api/proxy-pools/webshare/sync-auto", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });

          const data = await res.json();

          if (res.ok) {
            notify.success(
              `Sync completed!\nCreated: ${data.created}\nDead: ${data.deadDetected}\nRemoved: ${data.removedFrom9Router}`
            );
            onSync?.();
          } else {
            notify.error(data.error || "Sync failed");
          }
        } catch (err) {
          notify.error("Sync failed");
        } finally {
          setSyncing(false);
        }
      },
    });
  };

  const stats = ws.stats || {};
  const hasAutoSync = autoSync || ws.autoSync;

  return (
    <>
      <Card className="mb-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-blue-500">cloud</span>
            Webshare Integration
          </h3>
          {hasAutoSync && (
            <Badge variant="success" size="sm">Auto-sync: {syncInterval}m</Badge>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="text-xs font-medium text-text-muted mb-1 block">API Token</label>
            <Input
              type="password"
              placeholder="webshare.io API key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              size="sm"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-text-muted mb-1 block">Modo</label>
            <select
              className="w-full bg-surface-muted border border-border rounded-lg px-3 py-2 text-xs text-text-main"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              <option value="direct">Direct (IP:Port:User:Pass)</option>
              <option value="backbone">Backbone (Shared credential)</option>
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-text-muted mb-1 block">Página/Somente</label>
            <Input
              type="number"
              placeholder="100"
              value={pageSize}
              onChange={(e) => setPageSize(e.target.value)}
              size="sm"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-text-muted mb-1 block">Plan ID (opcional)</label>
            <Input
              placeholder="Deixe vazio para padrão"
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
              size="sm"
            />
          </div>
        </div>

        <div className="mb-4">
          <h4 className="text-sm font-medium text-text-main mb-2">Opções de Sync</h4>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <Toggle checked={autoReplace} onChange={(e) => setAutoReplace(e.target.checked)} />
              <span className="text-sm">Auto-substituir proxies mortos na Webshare</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <Toggle checked={removeDead} onChange={(e) => setRemoveDead(e.target.checked)} />
              <span className="text-sm">Remover proxies mortos do 9Router</span>
            </label>
          </div>
        </div>

        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-text-main">Auto-sync automático</label>
            <Badge variant={hasAutoSync ? "success" : "default"} size="sm">
              {hasAutoSync ? "Ativado" : "Desativado"}
            </Badge>
          </div>
          {hasAutoSync && (
            <div className="flex items-center gap-3 text-xs text-text-muted mb-2">
              <span>Intervalo:</span>
              <select
                className="bg-surface-muted border border-border rounded px-2 py-1 text-xs"
                value={syncInterval}
                onChange={(e) => setSyncInterval(e.target.value)}
              >
                {[15, 30, 60, 120, 240].map((min) => (
                  <option key={min} value={min}>{min} minutos</option>
                ))}
              </select>
            </div>
          )}
          <label className="flex items-center gap-2 cursor-pointer">
            <Toggle checked={hasAutoSync} onChange={(e) => {
              setAutoSync(e.target.checked);
              setSyncInterval(e.target.checked ? syncInterval : "60");
            }} />
            <span className="text-sm">Habilitar sync automático</span>
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
          <Button
            fullWidth
            onClick={handleSaveConfig}
            disabled={loading}
            size="sm"
          >
            {loading ? "Saving..." : "Salvar Configuração"}
          </Button>
          <Button
            fullWidth
            variant="secondary"
            onClick={handleSyncNow}
            disabled={syncing || loading || !apiKey.trim()}
            size="sm"
          >
            {syncing ? "Sincronizando..." : "Sync Agora"}
          </Button>
        </div>

        {stats.totalPools > 0 && (
          <div className="grid grid-cols-3 gap-3 text-center pt-3 border-t border-border/30">
            <div>
              <p className="text-xs text-text-muted">Total</p>
              <p className="text-lg font-semibold text-text-main">{stats.totalPools}</p>
            </div>
            <div>
              <p className="text-xs text-text-muted">Ativos</p>
              <p className="text-lg font-semibold text-emerald-600">{stats.activePools || 0}</p>
            </div>
            <div>
              <p className="text-xs text-text-muted">Syncs</p>
              <p className="text-lg font-semibold text-text-main">{stats.syncCount || 0}</p>
            </div>
          </div>
        )}
      </Card>

      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title}
        message={confirmState?.message}
        variant="warning"
      />
    </>
  );
}

export default WebshareConfigCard;