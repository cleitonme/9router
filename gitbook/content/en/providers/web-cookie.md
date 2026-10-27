# Web Cookie Providers - Connect With a Browser Session

Some providers do not issue an API key. They authenticate with the same cookie your browser uses after you sign in. 9Router can capture that cookie automatically or accept it pasted by hand.

> Use these providers only with accounts you own. The cookie is a live credential: anyone who has it can act as you on that site. Never share it, put it in a URL, or commit it to a repository.

---

## Two Ways to Connect

### 1. Automatic: Login via Browser (recommended)

1. Open the provider page in the 9Router dashboard.
2. Click **Login via Browser**.
3. A Chrome window opens on the provider site.
4. Sign in normally.
5. 9Router captures the session cookie and adds the connection.

This works because 9Router reads the browser context directly, including **HttpOnly** cookies that JavaScript cannot see.

### 2. Manual: paste the cookie

Open **Add Connection** and use the **How to get this cookie** guide. It offers three methods:

- **Console** - copies readable cookies with `document.cookie` (only works for non-HttpOnly cookies).
- **Network** - copy the `Cookie` request header from DevTools (works for every cookie, including HttpOnly).
- **Paste cURL** - paste the output of **Copy as cURL** and 9Router extracts the cookie for you.

---

## Which Method Works for Each Provider

| Provider | Credential | HttpOnly | Best method |
|---|---|---|---|
| Grok Web | `sso` (+ `sso-rw`, `cf_clearance`, `__cf_bm`) | Yes (`sso`) | Network or Login via Browser |
| ChatGPT Web | `__Secure-next-auth.session-token` (+ `.0`/`.1` chunks) | Yes | Network or Login via Browser |
| Gemini Web | `__Secure-1PSID` (+ `__Secure-1PSIDTS`) | Yes | Network or Login via Browser |
| Muse Web | `hatch_sess` (+ `hatch_gw`, `hatch_vml`, `hatch_native_auth_device`) | Try console | Console, Network, or Login via Browser |
| DeepSeek Web | `localStorage.userToken` | n/a | Console or Login via Browser |
| UC Web | `__client` (+ `__client_uat`) | Yes | Network or Login via Browser |
| Perplexity Web | `__Secure-next-auth.session-token` (value only) | Yes | Network |

> **HttpOnly means JavaScript cannot read it.** If a console command finds nothing, the cookie is HttpOnly. Use the Network tab instead.

---

## Console Method

Only use this when the credential is not HttpOnly. If the command reports missing cookies, switch to Network.

### DeepSeek Web

DeepSeek stores the token in `localStorage` under `userToken`. The value may be a JSON object with a `value` field.

1. Sign in at `https://chat.deepseek.com`.
2. Open DevTools (`F12`) -> **Console**.
3. Paste and run:

```js
(() => {
  const raw = localStorage.getItem("userToken");
  if (!raw) return console.warn("Not logged in: userToken not found.");
  let token = raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.value === "string") token = parsed.value;
  } catch (_) {}
  copy(token);
  console.log("Copied " + token.length + " characters.");
})();
```

4. Paste the clipboard value into the **Cookie Value** field in 9Router.

### Muse Web

1. Sign in at `https://muse.ai`.
2. Open DevTools (`F12`) -> **Console**.
3. Paste and run:

```js
(() => {
  const names = ["hatch_sess"];
  const optional = ["hatch_gw", "hatch_vml", "hatch_native_auth_device"];
  const jar = {};
  document.cookie.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i < 0) return;
    const name = part.slice(0, i).trim();
    if (!name) return;
    jar[name] = part.slice(i + 1).trim();
  });
  const found = [...names, ...optional].filter((name) => jar[name]);
  if (!jar["hatch_sess"]) {
    console.warn("hatch_sess not found. It may be HttpOnly — use the Network tab.");
    return;
  }
  const header = found.map((name) => name + "=" + jar[name]).join("; ");
  copy(header);
  console.log("Copied: " + found.join(", "));
})();
```

> Chrome may block pasting into the Console until you type `allow pasting` and press Enter.

---

## Network Method (works for HttpOnly)

Use this for Grok, ChatGPT, Gemini, UC, Perplexity, or whenever the console command finds nothing.

1. Sign in on the provider site.
2. Press `F12` and open the **Network** tab.
3. Reload the page or perform an action on the site.
4. Click a request made to the provider's own domain.
5. Open **Headers** -> **Request Headers**.
6. Find **Cookie**.
7. Right-click the value and choose **Copy value**.
8. Paste it into the **Cookie Value** field in 9Router.

For **Perplexity Web**, paste only the value of `__Secure-next-auth.session-token`, not the full header. 9Router adds the cookie name for you.

---

## Paste cURL Method

This is the fastest manual path when the Network tab is already open.

1. In DevTools -> **Network**, right-click a request to the provider.
2. Choose **Copy** -> **Copy as cURL**.
3. In 9Router, open **How to get this cookie** -> **Paste cURL**.
4. Paste the command and click **Extract and fill**.
5. The Cookie field is populated automatically.

The extractor accepts `-H 'Cookie: ...'`, `--header`, `-b`, `--cookie`, bash line continuations (`\`), and Windows `cmd` continuations (`^`).

---

## Troubleshooting

### The console says no cookies were found

The cookie is HttpOnly. Use the Network method or **Login via Browser**.

### The connection is created but requests fail

- The cookie expired. Sign in again and capture a fresh one.
- You copied the cookie from the wrong domain (for example, `accounts.google.com` instead of `gemini.google.com`).
- The provider requires additional cookies. Compare with the table above and copy the full `Cookie` header.
- Cloudflare may return `403`. A fresh `cf_clearance` cookie from the same browser session usually fixes it.

### Chrome blocks pasting in the Console

Type `allow pasting` in the Console, press Enter, then paste the command again.

### I do not want to use a browser

There is no API-key path for these providers. The manual cookie is the only alternative to **Login via Browser**.

---

## Security Checklist

- Run console commands on the provider domain, never on the 9Router dashboard.
- Never paste a cookie into a chat, issue, screenshot, or public URL.
- Use a dedicated browser profile when possible.
- Revoke the session on the provider site if the cookie leaks.
- Treat every connection in 9Router as a secret.
