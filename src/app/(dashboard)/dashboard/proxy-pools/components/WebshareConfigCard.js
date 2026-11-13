"use client";

import { useState } from "react";
import { Button, Badge, Card, ConfirmModal } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

export default function WebshareConfigCard({ webshareSync, onOpenConfig, onSync }) {
  const ws = webshareSync || {};
  const configured = ws.apiKeyConfigured === true || !!ws.apiKey;
  const autoSync = ws.autoSync === true;
  const interval = ws.syncIntervalMinutes || 60;
  const stats = ws.stats || {};

  const [syncing, setSyncing] = useState(false);
  const [confirmState, setConfirmState] = useState(null);
  const notify = useNotificationStore();

  const handleSyncNow = () => {
    setConfirmState({
      title: "Sincronizar proxies do Webshare agora?",
      message:
        "Testa os proxies existentes, substitui IPs mortos na Webshare (se ativado) e adiciona novos. Usa a configuração já salva.",
      onConfirm: async () => {
        setConfirmState(null);
        setSyncing(true);
        try {
          const res = await fetch("/api/proxy-pools/webshare/sync-auto", { method: "POST" });
          const data = await res.json();

          if (res.ok) {
            notify.success(
              `Sync concluído! Criados: ${data.created}, Mortos: ${data.deadDetected}, Removidos: ${data.removedFrom9Router}`
            );
            onSync?.();
          } else {
            notify.error(data.error || "Falha na sincronização");
          }
        } catch {
          notify.error("Falha na sincronização");
        } finally {
          setSyncing(false);
        }
      },
    });
  };

  return (
    <>
      <Card className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="material-symbols-outlined text-blue-500">cloud</span>
            <h3 className="text-lg font-semibold">Webshare Integration</h3>
            <Badge variant={configured ? "success" : "default"} size="sm">
              {configured ? "Configurado" : "Não configurado"}
            </Badge>
            <Badge variant={autoSync ? "success" : "default"} size="sm">
              {autoSync ? `Auto-sync: ${interval}m` : "Auto-sync: off"}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon="sync"
              onClick={handleSyncNow}
              disabled={!configured || syncing}
            >
              {syncing ? "Sincronizando..." : "Sync Agora"}
            </Button>
            <Button size="sm" icon="settings" onClick={onOpenConfig}>
              Configurar
            </Button>
          </div>
        </div>

        {(stats.totalPools > 0 || ws.lastSyncAt) && (
          <div className="mt-3 border-t border-border/30 pt-3">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-xs text-text-muted">Total</p>
                <p className="text-lg font-semibold text-text-main">{stats.totalPools || 0}</p>
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
            {ws.lastSyncAt && (
              <p className="mt-2 text-[11px] text-text-muted">
                Último sync: {new Date(ws.lastSyncAt).toLocaleString()}
              </p>
            )}
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