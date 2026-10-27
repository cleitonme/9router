"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import Button from "@/shared/components/Button";
import Modal from "@/shared/components/Modal";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { translate } from "@/i18n/runtime";
import { buildConsoleSnippet, getWebCookieHelp } from "@/shared/constants/webCookieHelp";
import { extractCookieHeaderFromCurl } from "@/shared/utils/curlCookie";

function TabButton({ active, onClick, icon, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-xs font-semibold transition-colors ${
        active
          ? "bg-brand-500/10 text-brand-500"
          : "text-text-muted hover:bg-surface-2 hover:text-text-main"
      }`}
    >
      {icon && <span className="material-symbols-outlined text-[16px]">{icon}</span>}
      {children}
    </button>
  );
}

TabButton.propTypes = {
  active: PropTypes.bool,
  onClick: PropTypes.func.isRequired,
  icon: PropTypes.string,
  children: PropTypes.node,
};

function Step({ index, children }) {
  return (
    <li className="flex gap-2 text-sm text-text-muted">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-500/10 text-[11px] font-bold text-brand-500">
        {index}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

Step.propTypes = {
  index: PropTypes.number.isRequired,
  children: PropTypes.node,
};

export default function WebCookieHelp({ providerId, providerName, variant = "inline", onApply }) {
  const help = getWebCookieHelp(providerId);
  const snippet = help ? buildConsoleSnippet(help) : "";
  const hasConsole = Boolean(snippet);
  const showNetwork = Boolean(help && !help.storageKey);
  const hasCurl = Boolean(help && !help.storageKey);
  const defaultTab = hasConsole ? "console" : showNetwork ? "network" : "console";

  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState(null);
  const [curlText, setCurlText] = useState("");
  const [error, setError] = useState("");
  const [applied, setApplied] = useState(false);
  const { copied, copy } = useCopyToClipboard();

  const activeTab = tab || defaultTab;

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      setIsOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [isOpen]);

  if (!help) return null;

  const open = (nextTab) => {
    setTab(nextTab || defaultTab);
    setApplied(false);
    setError("");
    setIsOpen(true);
  };

  const requiredLabels = help.requiredCookies.length
    ? help.requiredCookies
    : help.storageKey
      ? [`localStorage.${help.storageKey}`]
      : [];

  const handleApplyCurl = () => {
    const result = extractCookieHeaderFromCurl(curlText, {
      valueOnly: help.mode === "value",
      cookieNames: help.requiredCookies,
    });
    if (!result) {
      setApplied(false);
      setError(translate("Could not find a Cookie header in that cURL command."));
      return;
    }
    const value = help.mode === "value"
      ? (result.cookieValue || result.cookieHeader)
      : result.cookieHeader;
    setError("");
    if (onApply) {
      onApply(value);
      setApplied(true);
    } else {
      copy(value, "extracted");
    }
  };

  const trigger = variant === "card" ? (
    <div className="rounded-[10px] border border-border bg-surface-2 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-brand-500">cookie</span>
            <h3 className="text-sm font-semibold text-text-main">
              {translate("How to get this cookie")}
            </h3>
          </div>
          <p className="mt-1 text-xs text-text-muted">
            {providerName ? `${providerName}: ` : ""}
            {help.mode === "value"
              ? translate("Paste the token value, not a cookie header.")
              : translate("Paste the full Cookie header.")}
          </p>
          {requiredLabels.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {requiredLabels.map((label) => (
                <code
                  key={label}
                  className="rounded bg-black/5 px-1.5 py-0.5 text-[11px] text-text-muted dark:bg-white/5"
                >
                  {label}
                </code>
              ))}
            </div>
          )}
        </div>
        <Button size="sm" variant="secondary" icon="help" onClick={() => open()} className="shrink-0">
          {translate("Open guide")}
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-1">
        {hasConsole && (
          <Button size="sm" variant="ghost" icon="terminal" onClick={() => open("console")}>
            {translate("Console")}
          </Button>
        )}
        {showNetwork && (
          <Button size="sm" variant="ghost" icon="language" onClick={() => open("network")}>
            {translate("Network")}
          </Button>
        )}
        {hasCurl && (
          <Button size="sm" variant="ghost" icon="content_paste" onClick={() => open("curl")}>
            {translate("Paste cURL")}
          </Button>
        )}
      </div>
    </div>
  ) : (
    <button
      type="button"
      onClick={() => open()}
      className="inline-flex items-center gap-1 text-xs font-medium text-brand-500 hover:underline"
    >
      <span className="material-symbols-outlined text-[15px]">help</span>
      {translate("How to get this cookie")}
    </button>
  );

  return (
    <>
      {trigger}

      <Modal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title={`${translate("How to get this cookie")}${providerName ? ` — ${providerName}` : ""}`}
        size="lg"
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-1 border-b border-border pb-2">
            {hasConsole && (
              <TabButton active={activeTab === "console"} onClick={() => setTab("console")} icon="terminal">
                {translate("Console")}
              </TabButton>
            )}
            {showNetwork && (
              <TabButton active={activeTab === "network"} onClick={() => setTab("network")} icon="language">
                {translate("Network")}
              </TabButton>
            )}
            {hasCurl && (
              <TabButton active={activeTab === "curl"} onClick={() => setTab("curl")} icon="content_paste">
                {translate("Paste cURL")}
              </TabButton>
            )}
          </div>

          {activeTab === "console" && hasConsole && (
            <div className="flex flex-col gap-3">
              {help.httpOnly && (
                <div className="flex items-start gap-2 rounded-[8px] border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  <span className="material-symbols-outlined text-[16px]">warning</span>
                  <p>{translate("This cookie is HttpOnly. The console command may find nothing — use the Network tab instead.")}</p>
                </div>
              )}
              <ol className="flex flex-col gap-2">
                <Step index={1}>{translate("Open the provider site and sign in.")}</Step>
                <Step index={2}>{translate("Press F12, open the Console tab, paste the command below and press Enter.")}</Step>
                <Step index={3}>{translate("The value is copied to your clipboard. Paste it in the Cookie Value field.")}</Step>
              </ol>
              <div className="relative rounded-[10px] border border-border bg-black/[0.03] p-3 dark:bg-black/30">
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all pr-16 text-[11px] leading-relaxed text-text-main">
                  <code data-i18n-skip>{snippet}</code>
                </pre>
                <div className="absolute right-2 top-2">
                  <Button size="sm" variant="secondary" icon={copied === "snippet" ? "check" : "content_copy"} onClick={() => copy(snippet, "snippet")}>
                    {copied === "snippet" ? translate("Copied") : translate("Copy")}
                  </Button>
                </div>
              </div>
              <p className="text-xs text-text-muted">
                {translate("Chrome may block pasting until you type allow pasting in the Console.")}
              </p>
              {help.note && <p className="text-xs text-text-muted">{translate(help.note)}</p>}
            </div>
          )}

          {activeTab === "network" && showNetwork && (
            <div className="flex flex-col gap-3">
              <ol className="flex flex-col gap-2">
                <Step index={1}>{translate("Open the provider site and sign in.")}</Step>
                <Step index={2}>{translate("Press F12 and open the Network tab, then reload the page.")}</Step>
                <Step index={3}>{translate("Click a request to the provider domain, then open Headers > Request Headers.")}</Step>
                <Step index={4}>{translate("Right-click the Cookie value and choose Copy value.")}</Step>
                <Step index={5}>{translate("Paste it in the Cookie Value field.")}</Step>
              </ol>
              {requiredLabels.length > 0 && (
                <div className="rounded-[10px] border border-border bg-surface-2 p-3">
                  <p className="text-xs font-semibold text-text-main">{translate("Cookies to copy")}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {requiredLabels.map((label) => (
                      <code
                        key={label}
                        className="rounded bg-black/5 px-1.5 py-0.5 text-[11px] text-text-muted dark:bg-white/5"
                      >
                        {label}
                      </code>
                    ))}
                  </div>
                  {help.optionalCookies.length > 0 && (
                    <p className="mt-2 text-[11px] text-text-muted">
                      {translate("Optional")}: {help.optionalCookies.join(", ")}
                    </p>
                  )}
                </div>
              )}
              {help.httpOnly && (
                <p className="text-xs text-text-muted">
                  {translate("These cookies are HttpOnly, so they are not visible to document.cookie. The Network tab is the reliable method.")}
                </p>
              )}
              {help.note && <p className="text-xs text-text-muted">{translate(help.note)}</p>}
            </div>
          )}

          {activeTab === "curl" && hasCurl && (
            <div className="flex flex-col gap-3">
              <ol className="flex flex-col gap-2">
                <Step index={1}>{translate("In DevTools > Network, right-click a request to the provider and choose Copy > Copy as cURL.")}</Step>
                <Step index={2}>{translate("Paste the cURL command below and click Extract.")}</Step>
                <Step index={3}>{translate("The Cookie header is filled in automatically.")}</Step>
              </ol>
              <textarea
                value={curlText}
                onChange={(event) => {
                  setCurlText(event.target.value);
                  setApplied(false);
                  setError("");
                }}
                placeholder={"curl 'https://...' \\\n  -H 'cookie: ...'"}
                className="min-h-[140px] w-full resize-y rounded-[10px] border border-border bg-surface-2 p-3 font-mono text-xs text-text-main focus:border-brand-500/40 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" icon="content_paste" onClick={handleApplyCurl} disabled={!curlText.trim()}>
                  {translate("Extract and fill")}
                </Button>
                {onApply && applied && (
                  <span className="text-xs font-medium text-green-600 dark:text-green-400">
                    {translate("Cookie extracted and filled in.")}
                  </span>
                )}
                {!onApply && copied === "extracted" && (
                  <span className="text-xs font-medium text-green-600 dark:text-green-400">
                    {translate("Cookie copied to clipboard.")}
                  </span>
                )}
                {error && <span className="text-xs text-red-500">{error}</span>}
              </div>
              {!onApply && (
                <p className="text-xs text-text-muted">
                  {translate("No input to fill here — the extracted cookie is copied to your clipboard.")}
                </p>
              )}
            </div>
          )}

          <div className="flex items-start gap-2 rounded-[8px] border border-border bg-surface-2 px-3 py-2 text-[11px] text-text-muted">
            <span className="material-symbols-outlined text-[15px]">shield</span>
            <p>
              {translate("The command only copies the value locally. Run it on the provider domain, never on the 9Router dashboard, and do not share the cookie.")}
            </p>
          </div>
        </div>
      </Modal>
    </>
  );
}

WebCookieHelp.propTypes = {
  providerId: PropTypes.string.isRequired,
  providerName: PropTypes.string,
  variant: PropTypes.oneOf(["inline", "card"]),
  onApply: PropTypes.func,
};
