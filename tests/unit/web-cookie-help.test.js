import { describe, expect, it } from "vitest";
import {
  WEB_COOKIE_HELP,
  buildConsoleSnippet,
  getCookieLabel,
  getCookiePlaceholder,
  getWebCookieHelp,
} from "@/shared/constants/webCookieHelp.js";
import { extractCookieHeaderFromCurl, parseCookieHeader } from "@/shared/utils/curlCookie.js";
import { WEB_COOKIE_PROVIDERS } from "@/shared/constants/providers.js";

const EXPECTED_PROVIDERS = [
  "chatgpt-web",
  "deepseek-web",
  "gemini-web",
  "grok-web",
  "muse-web",
  "perplexity-web",
  "uc-web",
];

describe("web cookie help config", () => {
  it("has a help entry for every web-cookie provider", () => {
    expect(Object.keys(WEB_COOKIE_PROVIDERS).sort()).toEqual(EXPECTED_PROVIDERS);
    for (const providerId of EXPECTED_PROVIDERS) {
      expect(getWebCookieHelp(providerId), providerId).toBeTruthy();
    }
  });

  it("keeps the required cookies in sync with the provider auth hints", () => {
    expect(getWebCookieHelp("grok-web").requiredCookies).toContain("sso");
    expect(getWebCookieHelp("chatgpt-web").requiredCookies).toContain("__Secure-next-auth.session-token");
    expect(getWebCookieHelp("gemini-web").requiredCookies).toContain("__Secure-1PSID");
    expect(getWebCookieHelp("muse-web").requiredCookies).toContain("hatch_sess");
    expect(getWebCookieHelp("deepseek-web").storageKey).toBe("userToken");
    expect(getWebCookieHelp("uc-web").requiredCookies).toContain("__client");
    expect(getWebCookieHelp("perplexity-web").mode).toBe("value");
  });

  it("labels the DeepSeek credential as userToken", () => {
    expect(getCookieLabel(getWebCookieHelp("deepseek-web"))).toBe("userToken");
    expect(getCookieLabel(getWebCookieHelp("grok-web"))).toBe("Cookie Value");
    expect(getCookiePlaceholder(getWebCookieHelp("grok-web"))).toContain("sso=");
  });

  it("builds a localStorage snippet for DeepSeek and a header snippet for Muse", () => {
    const deepseek = buildConsoleSnippet(getWebCookieHelp("deepseek-web"));
    expect(deepseek).toContain('const key = "userToken"');
    expect(deepseek).toContain("localStorage.getItem(key)");
    expect(deepseek).toContain("JSON.parse");
    expect(deepseek).toContain("copy(token)");

    const muse = buildConsoleSnippet(getWebCookieHelp("muse-web"));
    expect(muse).toContain('"hatch_sess"');
    expect(muse).toContain("copy(header)");
    expect(muse).toContain("prefixes");
  });

  it("does not offer a console snippet for HttpOnly-only providers", () => {
    for (const providerId of ["grok-web", "chatgpt-web", "gemini-web", "uc-web", "perplexity-web"]) {
      expect(buildConsoleSnippet(getWebCookieHelp(providerId)), providerId).toBe("");
    }
  });

  it("runs the DeepSeek snippet and copies the unwrapped token", () => {
    let copied = "";
    const storage = { getItem: () => JSON.stringify({ value: "deepseek-token" }) };
    const run = new Function("localStorage", "copy", "console", buildConsoleSnippet(getWebCookieHelp("deepseek-web")));
    run(storage, (value) => { copied = value; }, { warn: () => {}, log: () => {} });
    expect(copied).toBe("deepseek-token");
  });

  it("runs the Muse snippet and copies only the available cookies", () => {
    let copied = "";
    const document = { cookie: "hatch_sess=abc; hatch_gw=def; unrelated=1" };
    const run = new Function("document", "copy", "console", buildConsoleSnippet(getWebCookieHelp("muse-web")));
    run(document, (value) => { copied = value; }, { warn: () => {}, log: () => {} });
    expect(copied).toBe("hatch_sess=abc; hatch_gw=def");
  });

  it("warns instead of copying when the required cookie is missing", () => {
    let copied = "";
    let warned = "";
    const document = { cookie: "hatch_gw=def" };
    const run = new Function("document", "copy", "console", buildConsoleSnippet(getWebCookieHelp("muse-web")));
    run(document, (value) => { copied = value; }, { warn: (message) => { warned = message; }, log: () => {} });
    expect(copied).toBe("");
    expect(warned).toContain("hatch_sess");
  });
});

describe("extractCookieHeaderFromCurl", () => {
  it("parses a bash -H Cookie header", () => {
    const result = extractCookieHeaderFromCurl(
      "curl 'https://grok.com/rest/app-chat/conversations/new' -H 'cookie: sso=abc; cf_clearance=def'",
    );
    expect(result).toEqual({
      cookieHeader: "sso=abc; cf_clearance=def",
      cookieValue: null,
      source: "curl",
    });
  });

  it("parses --header with double quotes", () => {
    const result = extractCookieHeaderFromCurl(
      'curl "https://chatgpt.com/" --header "Cookie: __Secure-next-auth.session-token=abc.0; other=1"',
    );
    expect(result.cookieHeader).toBe("__Secure-next-auth.session-token=abc.0; other=1");
  });

  it("parses -b and --cookie flags", () => {
    expect(extractCookieHeaderFromCurl("curl https://muse.ai/ -b 'hatch_sess=abc; hatch_gw=def'").cookieHeader)
      .toBe("hatch_sess=abc; hatch_gw=def");
    expect(extractCookieHeaderFromCurl("curl https://muse.ai/ --cookie 'hatch_sess=abc'").cookieHeader)
      .toBe("hatch_sess=abc");
  });

  it("normalizes cmd line continuations", () => {
    const result = extractCookieHeaderFromCurl(
      'curl "https://chatgpt.com/" ^\r\n  -H "Cookie: a=1; b=2"',
    );
    expect(result.cookieHeader).toBe("a=1; b=2");
  });

  it("normalizes bash line continuations", () => {
    const result = extractCookieHeaderFromCurl(
      "curl 'https://chatgpt.com/' \\\n  -H 'Cookie: a=1; b=2'",
    );
    expect(result.cookieHeader).toBe("a=1; b=2");
  });

  it("accepts a plain Cookie header and an inline Cookie: line", () => {
    expect(extractCookieHeaderFromCurl("sso=abc; cf_clearance=def").cookieHeader)
      .toBe("sso=abc; cf_clearance=def");
    expect(extractCookieHeaderFromCurl("Cookie: sso=abc").cookieHeader).toBe("sso=abc");
  });

  it("extracts the value only when requested", () => {
    const result = extractCookieHeaderFromCurl(
      "curl 'https://www.perplexity.ai/' -H 'Cookie: __Secure-next-auth.session-token=abc; other=1'",
      { valueOnly: true, cookieNames: ["__Secure-next-auth.session-token"] },
    );
    expect(result.cookieValue).toBe("abc");
    expect(result.cookieHeader).toBe("__Secure-next-auth.session-token=abc");
  });

  it("reassembles chunked NextAuth cookies for value-only extraction", () => {
    const result = extractCookieHeaderFromCurl(
      "curl 'https://chatgpt.com/' -H 'Cookie: __Secure-next-auth.session-token.0=abc; __Secure-next-auth.session-token.1=def'",
      { valueOnly: true, cookieNames: ["__Secure-next-auth.session-token"] },
    );
    expect(result.cookieValue).toBe("abcdef");
  });

  it("returns null when there is no cookie", () => {
    expect(extractCookieHeaderFromCurl("curl https://example.com/")).toBeNull();
    expect(extractCookieHeaderFromCurl("")).toBeNull();
  });

  it("parses cookie pairs", () => {
    expect(parseCookieHeader("a=1; b=2; malformed; =3")).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });
});
