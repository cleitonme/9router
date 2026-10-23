"use client";

import { useState } from "react";
import Modal from "./Modal";
import Button from "./Button";
import Badge from "./Badge";

const QUICK_THRESHOLDS = [60, 70, 75, 80, 85, 90];

function parseThreshold(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return 80;
  return Math.round(raw <= 1 ? raw * 100 : raw) || 80;
}

const POLICIES = [
  {
    id: "smart",
    title: "Smart Switch",
    badge: "Adaptive ≥80%",
    badgeVariant: "success",
    icon: "auto_mode",
    recommended: true,
    desc: "Preserves warm prompt cache across turns. Switches models only when the conversation shifts and the router is highly confident.",
  },
  {
    id: "strict",
    title: "Strict Lock",
    badge: "1 Task = 1 Session",
    badgeVariant: "default",
    icon: "lock",
    desc: "Evaluates the router on the first turn, then locks that model for the whole session: zero extra router calls and 100% prompt cache reuse.",
  },
  {
    id: "per-turn",
    title: "Per-Turn",
    badge: "Dynamic",
    badgeVariant: "default",
    icon: "refresh",
    desc: "Evaluates the router on every prompt without session stickiness. Best when tasks change completely between turns.",
  },
  {
    id: "custom",
    title: "Custom Threshold",
    badge: "Adaptive",
    badgeVariant: "default",
    icon: "tune",
    desc: "Same as Smart Switch, with your own confidence threshold required to switch models.",
  },
];

export default function SmartPolicyModal({
  isOpen,
  onClose,
  comboName,
  currentPolicy = "smart",
  currentThreshold = 80,
  onSave,
}) {
  // The parent mounts this modal on demand, so initializing from props is enough;
  // no effect/sync needed and reopening always starts from the saved policy.
  const [selectedPolicy, setSelectedPolicy] = useState(
    currentPolicy === "smart-switch" ? "smart" : (currentPolicy || "smart")
  );
  const [threshold, setThreshold] = useState(() => parseThreshold(currentThreshold));

  const handleSave = () => {
    const confidenceThreshold = selectedPolicy === "custom"
      ? threshold / 100
      : selectedPolicy === "smart"
        ? 0.8
        : 0;
    onSave({
      smartPolicy: selectedPolicy,
      sessionSticky: selectedPolicy !== "per-turn",
      confidenceThreshold,
    });
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Router Policy — ${comboName || "Combo"}`}
      size="lg"
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted">
          Choose how the System One router keeps model selection stable across conversation turns:
        </p>

        <div className="flex flex-col gap-2.5">
          {POLICIES.map((policy) => {
            const isSelected = selectedPolicy === policy.id;
            return (
              <div
                key={policy.id}
                onClick={() => setSelectedPolicy(policy.id)}
                className={`relative flex flex-col rounded-xl border p-3 cursor-pointer transition-all ${
                  isSelected
                    ? "border-primary bg-primary/[0.04] shadow-sm"
                    : "border-border/60 hover:border-border hover:bg-black/[0.01] dark:hover:bg-white/[0.01]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`size-4 rounded-full border flex items-center justify-center shrink-0 transition-all ${
                        isSelected ? "border-primary bg-primary text-white" : "border-border-subtle bg-surface"
                      }`}
                    >
                      {isSelected && <span className="size-1.5 rounded-full bg-white" />}
                    </span>
                    <span className="size-5 rounded flex items-center justify-center shrink-0 text-text-muted">
                      <span className="material-symbols-outlined text-[15px] leading-none select-none inline-block">
                        {policy.icon}
                      </span>
                    </span>
                    <span className="text-sm font-medium text-text-main">{policy.title}</span>
                    {policy.recommended && (
                      <span className="text-[10px] uppercase tracking-wide font-semibold text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                        Recommended
                      </span>
                    )}
                  </div>
                  <Badge variant={policy.badgeVariant} size="sm">
                    {policy.id === "custom" ? `Adaptive ≥${threshold}%` : policy.badge}
                  </Badge>
                </div>

                <p className="text-xs text-text-muted mt-1.5 pl-6 leading-relaxed">{policy.desc}</p>

                {policy.id === "custom" && isSelected && (
                  <div
                    className="mt-3 pl-6 pt-3 border-t border-border/40 flex flex-col gap-2.5"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-text-muted">Switch confidence threshold:</span>
                      <span className="font-mono font-semibold text-primary text-sm">{threshold}%</span>
                    </div>

                    <input
                      type="range"
                      min="50"
                      max="95"
                      step="1"
                      value={threshold}
                      onChange={(event) => setThreshold(Number(event.target.value))}
                      className="w-full accent-primary cursor-pointer h-1.5 bg-black/10 dark:bg-white/10 rounded-lg appearance-none"
                    />

                    <div className="flex items-center gap-1.5 pt-1">
                      <span className="text-[10px] text-text-muted mr-1">Presets:</span>
                      {QUICK_THRESHOLDS.map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          onClick={() => setThreshold(pct)}
                          className={`px-2 py-0.5 rounded text-[11px] font-mono transition-colors ${
                            threshold === pct
                              ? "bg-primary text-white font-semibold"
                              : "bg-black/5 dark:bg-white/5 text-text-muted hover:text-text-main"
                          }`}
                        >
                          {pct}%
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="rounded-xl border border-primary/20 bg-primary/[0.03] p-3 text-xs flex items-start gap-2.5">
          <span className="material-symbols-outlined text-primary text-[18px] shrink-0 mt-0.5">bolt</span>
          <div className="text-text-muted leading-relaxed">
            <span className="font-medium text-text-main">Prompt cache benefits: </span>
            Keeping the same model across turns keeps upstream prompt caches warm, reducing input
            token costs and latency (Claude prompt cache, DeepSeek KV-cache, Gemini implicit cache).
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/40">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={handleSave}>
            Save Policy
          </Button>
        </div>
      </div>
    </Modal>
  );
}
