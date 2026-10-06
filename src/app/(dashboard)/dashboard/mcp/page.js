"use client";

import { useState, useEffect } from "react";
import { Card, Button, McpMarketplaceModal } from "@/shared/components";

export default function McpDashboardPage() {
  const [tools, setTools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedClient, setSelectedClient] = useState("opencode");
  const [copied, setCopied] = useState(false);
  const [showMarketplace, setShowMarketplace] = useState(false);

  useEffect(() => {
    async function fetchTools() {
      try {
        const res = await fetch("/api/mcp/native/tools");
        if (res.ok) {
          const data = await res.json();
          setTools(data.tools || []);
        }
      } catch (err) {
        console.error("Failed to load MCP tools:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchTools();
  }, []);

  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:20127";
  const sseUrl = `${origin}/api/mcp/native/sse`;

  const configSnippets = {
    opencode: JSON.stringify(
      {
        mcp: {
          ninerouter: {
            type: "remote",
            url: sseUrl,
            enabled: true,
            headers: {
              // Mesma API key usada no endpoint OpenAI-compatible (/v1).
              // Crie em Dashboard → API Keys e substitua abaixo.
              Authorization: "Bearer SUA_API_KEY_DO_9ROUTER",
            },
          },
        },
      },
      null,
      2
    ),
    claude: JSON.stringify(
      {
        mcpServers: {
          ninerouter: {
            url: sseUrl,
          },
        },
      },
      null,
      2
    ),
    cursor: JSON.stringify(
      {
        mcpServers: {
          ninerouter: {
            url: sseUrl,
          },
        },
      },
      null,
      2
    ),
    stdio: JSON.stringify(
      {
        mcpServers: {
          ninerouter: {
            command: "node",
            args: ["src/mcp/bin.js"],
          },
        },
      },
      null,
      2
    ),
  };

  const handleCopy = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text-main flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-[28px]">hub</span>
            MCP Server (Model Context Protocol)
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Conecte o 9Router nativamente aos seus assistentes e IDEs de IA como um servidor de ferramentas.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setShowMarketplace(true)}>
            <span className="material-symbols-outlined text-[18px] mr-1">storefront</span>
            MCP Marketplace
          </Button>
        </div>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="flex items-center gap-4 p-4 border border-border bg-surface">
          <div className="w-10 h-10 rounded-full bg-green-500/10 flex items-center justify-center text-green-500">
            <span className="material-symbols-outlined">wifi</span>
          </div>
          <div>
            <div className="text-xs text-text-muted uppercase font-semibold">Transporte SSE</div>
            <div className="text-sm font-bold text-text-main">Ativo (/api/mcp/native/sse)</div>
          </div>
        </Card>

        <Card className="flex items-center gap-4 p-4 border border-border bg-surface">
          <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center text-blue-500">
            <span className="material-symbols-outlined">terminal</span>
          </div>
          <div>
            <div className="text-xs text-text-muted uppercase font-semibold">Transporte Stdio</div>
            <div className="text-sm font-bold text-text-main">Disponível (CLI / bin.js)</div>
          </div>
        </Card>

        <Card className="flex items-center gap-4 p-4 border border-border bg-surface">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
            <span className="material-symbols-outlined">construction</span>
          </div>
          <div>
            <div className="text-xs text-text-muted uppercase font-semibold">Ferramentas Carregadas</div>
            <div className="text-sm font-bold text-text-main">{tools.length || 12} ferramentas nativas</div>
          </div>
        </Card>
      </div>

      {/* Connection Guide */}
      <Card className="p-6 border border-border bg-surface flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
          <h2 className="text-lg font-semibold text-text-main flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">integration_instructions</span>
            Configuração Rápida do Cliente
          </h2>
          <div className="flex items-center gap-1 bg-surface-muted p-1 rounded-lg border border-border">
            {["opencode", "claude", "cursor", "stdio"].map((client) => (
              <button
                key={client}
                onClick={() => setSelectedClient(client)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                  selectedClient === client
                    ? "bg-primary text-white"
                    : "text-text-muted hover:text-text-main"
                }`}
              >
                {client === "opencode" && "OpenCode"}
                {client === "claude" && "Claude Code / Desktop"}
                {client === "cursor" && "Cursor / Windsurf"}
                {client === "stdio" && "Stdio Local"}
              </button>
            ))}
          </div>
        </div>

        <div className="relative">
          <pre className="p-4 bg-zinc-950 text-zinc-100 rounded-lg text-xs font-mono overflow-x-auto border border-zinc-800">
            {configSnippets[selectedClient]}
          </pre>
          <button
            onClick={() => handleCopy(configSnippets[selectedClient])}
            className="absolute top-3 right-3 px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs rounded border border-zinc-700 flex items-center gap-1 transition-colors"
          >
            <span className="material-symbols-outlined text-[14px]">
              {copied ? "check" : "content_copy"}
            </span>
            {copied ? "Copiado!" : "Copiar"}
          </button>
        </div>
      </Card>

      {/* Tools List */}
      <Card className="p-6 border border-border bg-surface flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-text-main flex items-center gap-2 border-b border-border pb-3">
          <span className="material-symbols-outlined text-primary">build</span>
          Ferramentas Nativas Registradas
        </h2>

        {loading ? (
          <div className="p-6 text-center text-text-muted">Carregando ferramentas...</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {tools.map((tool) => (
              <div
                key={tool.name}
                className="p-4 rounded-lg border border-border bg-surface-muted/40 flex flex-col gap-2 hover:border-primary/50 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-bold text-primary bg-primary/10 px-2 py-0.5 rounded">
                    {tool.name}
                  </span>
                  <span className="text-[10px] uppercase font-semibold text-text-muted">
                    {tool.name.startsWith("9router_") ? "Administração" : "Operacional"}
                  </span>
                </div>
                <p className="text-xs text-text-muted">{tool.description}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Marketplace Modal */}
      <McpMarketplaceModal isOpen={showMarketplace} onClose={() => setShowMarketplace(false)} />
    </div>
  );
}
