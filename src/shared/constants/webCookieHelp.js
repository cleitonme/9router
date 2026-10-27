// Manual cookie-entry help for web-cookie providers.
//
// Kept out of the provider registry on purpose: the registry output is
// snapshot-tested in tests/__baseline__/verify-providers.mjs. This module is
// UI-only and never touches the routing path.

export const WEB_COOKIE_HELP = {
  "grok-web": {
    site: "https://grok.com",
    domain: "grok.com",
    mode: "header",
    requiredCookies: ["sso"],
    optionalCookies: ["sso-rw", "cf_clearance", "__cf_bm"],
    cookiePrefixes: [],
    httpOnly: true,
    console: "none",
    placeholder: "sso=...; cf_clearance=...",
    note: "The sso cookie is HttpOnly, so document.cookie cannot read it. Use the Network tab or Login via Browser.",
  },
  "chatgpt-web": {
    site: "https://chatgpt.com",
    domain: "chatgpt.com",
    mode: "header",
    requiredCookies: ["__Secure-next-auth.session-token"],
    optionalCookies: [],
    cookiePrefixes: ["__Secure-next-auth.session-token."],
    httpOnly: true,
    console: "none",
    placeholder: "__Secure-next-auth.session-token=...",
    note: "NextAuth session cookies are HttpOnly and may be split into .0/.1 chunks. Copy the full Cookie header from Network.",
  },
  "gemini-web": {
    site: "https://gemini.google.com",
    domain: "gemini.google.com",
    mode: "header",
    requiredCookies: ["__Secure-1PSID"],
    optionalCookies: ["__Secure-1PSIDTS"],
    cookiePrefixes: [],
    httpOnly: true,
    console: "none",
    placeholder: "__Secure-1PSID=...; __Secure-1PSIDTS=...",
    note: "Google auth cookies are HttpOnly. Copy the full Cookie header from Network.",
  },
  "muse-web": {
    site: "https://muse.ai",
    domain: "muse.ai",
    mode: "header",
    requiredCookies: ["hatch_sess"],
    optionalCookies: ["hatch_gw", "hatch_vml", "hatch_native_auth_device"],
    cookiePrefixes: [],
    httpOnly: false,
    console: "try",
    placeholder: "hatch_sess=...; hatch_gw=...; hatch_vml=...",
    note: "hatch_sess identifies the session; the other hatch_* cookies enrich the jar. If the console finds nothing, use Network.",
  },
  "deepseek-web": {
    site: "https://chat.deepseek.com",
    domain: "chat.deepseek.com",
    mode: "value",
    requiredCookies: [],
    optionalCookies: [],
    cookiePrefixes: [],
    storageKey: "userToken",
    httpOnly: false,
    console: "full",
    placeholder: "userToken value (eyJhbGciOi...)",
    note: "DeepSeek stores the token in localStorage under userToken. It may be a JSON object with a value field.",
  },
  "uc-web": {
    site: "https://uncensored.com",
    domain: "uncensored.com",
    mode: "header",
    requiredCookies: ["__client"],
    optionalCookies: ["__client_uat"],
    cookiePrefixes: [],
    httpOnly: true,
    console: "none",
    placeholder: "__client=...; __client_uat=...",
    note: "Clerk session cookies are HttpOnly. Copy the full Cookie header from Network, including __client.",
  },
  "perplexity-web": {
    site: "https://www.perplexity.ai",
    domain: "perplexity.ai",
    mode: "value",
    requiredCookies: ["__Secure-next-auth.session-token"],
    optionalCookies: [],
    cookiePrefixes: [],
    httpOnly: true,
    console: "none",
    placeholder: "eyJhbGciOi... (token value only)",
    note: "Paste only the token value. NextAuth session cookies are HttpOnly — copy the value from Network.",
  },
};

export function getWebCookieHelp(providerId) {
  return WEB_COOKIE_HELP[providerId] || null;
}

export function getCookieLabel(help) {
  return help?.mode === "value" && help?.storageKey ? help.storageKey : "Cookie Value";
}

export function getCookiePlaceholder(help) {
  return help?.placeholder || "";
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildConsoleSnippet(help) {
  if (!help || help.console === "none") return "";

  if (help.storageKey) {
    return `(() => {
  const key = ${JSON.stringify(help.storageKey)};
  const raw = localStorage.getItem(key);
  if (!raw) return console.warn("Not logged in: " + key + " not found.");
  let token = raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.value === "string") token = parsed.value;
  } catch (_) {}
  copy(token);
  console.log("Copied " + token.length + " characters.");
})();`;
  }

  if (help.mode === "value") {
    const cookieName = help.requiredCookies[0] || "";
    return `(() => {
  const name = ${JSON.stringify(cookieName)};
  const pattern = new RegExp("(?:^|;\\\\s*)" + ${JSON.stringify(escapeForRegExp(cookieName))} + "=([^;]+)");
  const match = document.cookie.match(pattern);
  if (!match) return console.warn("Cookie not found. It may be HttpOnly — use the Network tab.");
  copy(decodeURIComponent(match[1]));
  console.log("Copied token value.");
})();`;
  }

  const required = help.requiredCookies || [];
  const optional = help.optionalCookies || [];
  const prefixes = help.cookiePrefixes || [];
  return `(() => {
  const required = ${JSON.stringify(required)};
  const optional = ${JSON.stringify(optional)};
  const prefixes = ${JSON.stringify(prefixes)};
  const jar = {};
  document.cookie.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i < 0) return;
    const name = part.slice(0, i).trim();
    if (!name) return;
    jar[name] = part.slice(i + 1).trim();
  });
  const wanted = [...required, ...optional];
  const found = Object.keys(jar).filter((name) =>
    wanted.includes(name) || prefixes.some((prefix) => name.startsWith(prefix))
  );
  const missing = required.filter((name) => !found.some((item) => item === name || item.startsWith(name + ".")));
  if (missing.length) {
    console.warn("Missing required cookies: " + missing.join(", ") + ". They may be HttpOnly — use the Network tab.");
    return;
  }
  const header = found.map((name) => name + "=" + jar[name]).join("; ");
  copy(header);
  console.log("Copied: " + found.join(", ") + " (" + header.length + " characters)");
})();`;
}
