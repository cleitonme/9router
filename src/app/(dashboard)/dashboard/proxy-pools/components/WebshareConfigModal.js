"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Input, Toggle, Badge, Modal, ConfirmModal } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

const INTERVAL_OPTIONS = [15, 30, 60, 120, 240];

export default function WebshareConfigModal({ isOpen, onClose, webshareSync, onUpdated }) {
  const ws = webshareSync || {};

  const [apiKey, setApiKey] = useState("");
  const [mode, setMode] = useState("direct");
  const [pageSize, setPageSize] = useState("100");
  const [planId, setPlanId] = useState("");
  const [autoReplace, setAutoReplace] = useState(true);
  const [removeDead, setRemoveDead] = useState(true);
  const [autoSync, setAutoSync] = useState(false);
  const [syncInterval, setSyncInterval] = useState("60");
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);

  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [confirmState, setConfirmState] = useState(null);

  const notify = useNotificationStore();
  const wasOpen = useRef(false);

  // Populate the form from persisted settings only on the closed -> open
  // transition. A background refetch while the modal is open must not clobber
  // what the user is typing.
  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      setApiKey("");
      setMode(ws.mode || "direct");
      setPageSize(String(ws.pageSize || 100));
      setPlanId(ws.planId || "");
      setAutoReplace(ws.autoReplaceOnWebshare !== false);
      setRemoveDead(ws.removeDeadFrom9Router !== false);
      setAutoSync(ws.autoSync === true);
      setSyncInterval(String(ws.syncIntervalMinutes || 60));
      setApiKeyConfigured(ws.apiKeyConfigured === true);
    }
    wasOpen.current = isOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const busy = loading || importing || syncing;

  const close = () => {
    if (busy) return;
    onClose?.();
  };

  const handleSave = async () => {
    setLoading(true);
    try {
      const payload = {
        mode,
        pageSize: Number(pageSize) || 100,
        planId,
        autoReplaceOnWebshare: autoReplace,
        removeDeadFrom9Router: removeDead,
        autoSync,
        syncIntervalMinutes: Number(syncInterval) || 60,
      };
      const trimmedKey = apiKey.trim();
      if (trimmedKey) payload.apiKey = trimmedKey;

      const res = await fetch("/api/proxy-pools/webshare/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (res.ok) {
        notify.success("Configuração do Webshare salva");
        if (trimmedKey) setApiKey("");
        setApiKeyConfigured(data.apiKeyConfigured === true);
        onUpdated?.();
      } else {
        notify.error(data.error || "Falha ao salvar a configuração");
      }
    } catch {
      notify.error("Erro ao salvar a configuração");
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async () => {
    if (!apiKey.trim()) {
      notify.warning("Informe o API Token para importar os proxies.");
      return;
    }
    setImporting(true);
    try {
      const res = await fetch("/api/proxy-pools/webshare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: apiKey.trim(),
          mode,
          pageSize: Number(pageSize) || 100,
          planId: planId.trim() || undefined,
        }),
      });
      const data = await res.json();

      if (res.ok) {
        notify.success(
          `Webshare: ${data.created} proxy(s) importado(s) (Ignorados: ${data.skipped}, Total: ${data.total})`
        );
        onUpdated?.();
      } else {
        notify.error(data.error || "Falha ao importar do Webshare");
      }
    } catch {
      notify.error("Erro ao conectar com a API do Webshare");
    } finally {
      setImporting(false);
    }
  };

  const handleSyncNow = () => {
    setConfirmState({
      title: "Sincronizar proxies do Webshare agora?",
      message:
        "Isto vai:\n- Testar os proxies Webshare existentes\n- Substituir IPs mortos na Webshare (se ativado)\n- Adicionar novos proxies\n- Desativar/remover proxies mortos\n\nUsa a configuração já salva. Tempo estimado: 1-5 minutos.",
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
            onUpdated?.();
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
      <Modal isOpen={isOpen} title="Webshare Integration" onClose={close}>
        <div className="flex flex-col gap-4">
          <p className="text-xs text-text-muted">
            Configure o token da API e as opções de sincronização automática. Obtenha o token em{" "}
            <a
              href="https://dashboard.webshare.io/userapi/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Webshare Dashboard →
            </a>
          </p>

          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <label className="text-xs font-medium text-text-muted">API Token</label>
              <Badge variant={apiKeyConfigured ? "success" : "default"} size="sm">
                {apiKeyConfigured ? "Configurado" : "Não configurado"}
              </Badge>
            </div>
            <Input
              type="password"
              placeholder={apiKeyConfigured ? "•••••••• (deixe vazio para manter)" : "webshare.io API key"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              size="sm"
            />
            <p className="mt-1 text-[11px] text-text-muted">
              {apiKeyConfigured
                ? "O token salvo não é exibido por segurança. Deixe vazio para mantê-lo."
                : "Informe o token para ativar a integração."}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-text-muted">Modo</label>
              <select
                className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-xs text-text-main"
                value={mode}
                onChange={(e) => setMode(e.target.value)}
              >
                <option value="direct">Direct (IP:Port:User:Pass)</option>
                <option value="backbone">Backbone (Shared credential)</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-text-muted">Quantidade / página</label>
              <Input
                type="number"
                placeholder="100"
                value={pageSize}
                onChange={(e) => setPageSize(e.target.value)}
                size="sm"
              />
            </div>
            <div className="md:col-span-2">
              <label className="mb-1 block text-xs font-medium text-text-muted">Plan ID (opcional)</label>
              <Input
                placeholder="Deixe vazio para o padrão"
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
                size="sm"
              />
            </div>
          </div>

          <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-surface-muted/40 p-3">
            <p className="text-xs font-semibold text-text-main">Opções de Sync</p>
            <Toggle
              checked={autoReplace}
              onChange={(value) => setAutoReplace(value)}
              label="Auto-substituir proxies mortos na Webshare"
            />
            <Toggle
              checked={removeDead}
              onChange={(value) => setRemoveDead(value)}
              label="Remover proxies mortos do 9Router"
            />
          </div>

          <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-surface-muted/40 p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-text-main">Sync automático</p>
              <Badge variant={autoSync ? "success" : "default"} size="sm">
                {autoSync ? "Ativado" : "Desativado"}
              </Badge>
            </div>
            <Toggle
              checked={autoSync}
              onChange={(value) => {
                setAutoSync(value);
                if (!value) setSyncInterval("60");
              }}
              label="Habilitar sync automático"
            />
            {autoSync && (
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <span>Intervalo:</span>
                <select
                  className="rounded border border-border bg-surface-muted px-2 py-1 text-xs"
                  value={syncInterval}
                  onChange={(e) => setSyncInterval(e.target.value)}
                >
                  {INTERVAL_OPTIONS.map((min) => (
                    <option key={min} value={min}>{min} minutos</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button fullWidth size="sm" onClick={handleSave} disabled={busy}>
              {loading ? "Salvando..." : "Salvar Configuração"}
            </Button>
            <Button
              fullWidth
              size="sm"
              variant="secondary"
              icon="sync"
              onClick={handleSyncNow}
              disabled={busy || !apiKeyConfigured}
            >
              {syncing ? "Sincronizando..." : "Sync Agora"}
            </Button>
            <Button
              fullWidth
              size="sm"
              variant="secondary"
              icon="download"
              onClick={handleImport}
              disabled={busy || !apiKey.trim()}
            >
              {importing ? "Importando..." : "Importar Lista"}
            </Button>
            <Button fullWidth size="sm" variant="ghost" onClick={close} disabled={busy}>
              Fechar
            </Button>
          </div>
        </div>
      </Modal>

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