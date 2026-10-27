// Extract a Cookie header (or a single cookie value) from a pasted cURL
// command. Supports Chrome's "Copy as cURL (bash)" and "(cmd)" variants.

export function parseCookieHeader(header) {
  const entries = [];
  String(header || "").split(";").forEach((part) => {
    const index = part.indexOf("=");
    if (index <= 0) return;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) return;
    entries.push([name, value]);
  });
  return entries;
}

function unescapeShell(value) {
  return String(value || "")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\$/g, "$")
    .replace(/\\\\/g, "\\");
}

function findCookieValue(entries, name) {
  const exact = entries.find(([cookieName]) => cookieName === name);
  if (exact) return exact[1];

  const chunks = entries
    .filter(([cookieName]) => cookieName.startsWith(`${name}.`))
    .sort(([a], [b]) => Number(a.slice(name.length + 1)) - Number(b.slice(name.length + 1)));
  if (chunks.length) return chunks.map(([, value]) => value).join("");
  return null;
}

function finalize(header, { valueOnly, cookieNames }) {
  const cleaned = String(header || "").replace(/^\s*cookie\s*:\s*/i, "").trim();
  if (!cleaned) return null;

  if (!valueOnly) {
    return { cookieHeader: cleaned, cookieValue: null, source: "curl" };
  }

  const entries = parseCookieHeader(cleaned);
  for (const name of cookieNames || []) {
    const value = findCookieValue(entries, name);
    if (value != null) {
      return { cookieHeader: `${name}=${value}`, cookieValue: value, source: "curl" };
    }
  }

  if (!cleaned.includes("=")) {
    return { cookieHeader: cleaned, cookieValue: cleaned, source: "curl" };
  }
  return null;
}

export function extractCookieHeaderFromCurl(rawText, options = {}) {
  const config = {
    valueOnly: options.valueOnly === true,
    cookieNames: Array.isArray(options.cookieNames) ? options.cookieNames : [],
  };
  const text = String(rawText || "");
  if (!text.trim()) return null;

  const looksLikeCurl = /\bcurl(?:\.exe)?\b/i.test(text);
  const hasHeaderFlag = /(?:^|\s)(?:-H|--header|-b|--cookie)(?:\s+|=)/.test(text);
  if (!looksLikeCurl && !hasHeaderFlag) {
    return finalize(text, config);
  }

  const normalized = text
    .replace(/\\\r?\n/g, " ")
    .replace(/\^\r?\n/g, " ")
    .replace(/\\\r/g, " ")
    .replace(/\^\r/g, " ");

  const headerValues = [];
  const cookieFlagValues = [];

  const headerPattern = /(?:^|\s)(?:-H|--header)(?:\s+|=)(['"])([\s\S]*?)\1/g;
  let match;
  while ((match = headerPattern.exec(normalized))) {
    const value = unescapeShell(match[2]);
    if (/^\s*cookie\s*:/i.test(value)) {
      headerValues.push(value.replace(/^\s*cookie\s*:\s*/i, ""));
    }
  }

  const cookieFlagPattern = /(?:^|\s)(?:-b|--cookie)(?:\s+|=)(['"])([\s\S]*?)\1/g;
  while ((match = cookieFlagPattern.exec(normalized))) {
    const value = unescapeShell(match[2]).trim();
    if (value) cookieFlagValues.push(value);
  }

  for (const candidate of [...headerValues, ...cookieFlagValues]) {
    const result = finalize(candidate, config);
    if (result) return result;
  }

  const inline = normalized.match(/cookie\s*:\s*([^'"\r\n]+)/i);
  if (inline) return finalize(inline[1], config);

  return null;
}
