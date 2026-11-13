---
title: "Web-session providers — browser sign-in"
version: 3.8.51
lastUpdated: 2026-11-09
---

# Web-session providers — browser sign-in

Some providers do not issue an API key. They authenticate a **web session**: the
same cookie or bearer token your browser holds after you sign in to the
provider's own chat site.

Traditionally you would copy that value by hand — open DevTools → Network →
find an authenticated request → copy the `Cookie` header → paste it into
OmniRoute. OmniRoute can now do that for you: **click "Sign in with browser",
sign in as usual, and the session is captured and stored.**

---

## The one-click flow

1. Open the provider page in the OmniRoute dashboard.
2. In **Add connection**, click **Sign in with browser**.
3. A browser window opens on the OmniRoute host at the provider's sign-in page.
4. Sign in there. OmniRoute watches the session and captures it as soon as the
   provider's credential appears. The window closes on its own.
5. The connection is **created and stored automatically** — there is no second
   "Save" step. The dashboard returns to the connection list with the new
   connection in it.

For an existing connection, open **Edit** and click **Re-sync session** — the
new session is stored directly on the connection, with no copy/paste step.

> **The browser opens on the OmniRoute host**, not in your dashboard tab — but it
> is the *same browser* you are using to view the dashboard (see
> **Which browser opens**). On a desktop install that is your own machine. On a
> remote/server deployment it is the server's display — sign in there, or fall
> back to pasting the credential.

---

## Which browser opens

The sign-in window opens in **the same browser you are using right now** — the
dashboard detects it and tells the server, so you sign in where you already
are:

| You are using | The window that opens |
| ------------- | --------------------- |
| Firefox       | Firefox               |
| Chrome        | Chrome                |
| Edge          | Edge                  |
| Safari        | Safari's engine (WebKit) — Safari itself exposes no automation API |

The sign-in **never** opens a different browser: a Firefox dashboard always
gets a Firefox window, even when that is harder for the host to provide. If
the requested browser cannot be started, the sign-in stops with an
explanation instead of quietly opening something else.

The panel above the button names the browser, so there is never a guess about
which window to look for.

### Nothing to install on your side

The browser build is an **OmniRoute-side** dependency. When the host does not
have the build cached yet, the host downloads it itself on the first sign-in
that needs it (a one-time download, cached in the Playwright browser cache
under the host's home directory). The panel says *"The OmniRoute host
downloads it on the first sign-in — there is nothing to install on your
side."*

### The same window, when the browser allows it

A browser only exposes its automation protocol when it was started with a
remote-debugging endpoint. When the browser you are using is running that
way, OmniRoute **attaches to that very browser**:

- the sign-in tab opens **in the window you already have open**, next to the
  dashboard tab;
- the capture uses the accounts you are already signed in with — no password
  at all;
- only the tab OmniRoute opened is closed afterwards; your own tabs and your
  browser are left untouched.

The panel says *"Uses the Chrome that is already running — you are signed in
there already."* when this is the case.

When the browser was started the ordinary way, the sign-in opens a new window
of the same browser with a **dedicated profile per provider**: you sign in
once, the profile is kept, and every later re-sync is silent.

To turn the attach off:

```bash
OMNIROUTE_WEB_SESSION_CDP=off
```

To attach to a browser on a different port:

```bash
OMNIROUTE_WEB_SESSION_CDP_URL=http://127.0.0.1:9222
```

### When the dashboard is on another machine

If you view the dashboard from a laptop while OmniRoute runs on a server, the
browser family is ignored — your laptop's browser says nothing about what the
server can open. The server then uses its own default browser.

The check is the real network peer of the request, so a dashboard opened on
the OmniRoute machine itself is recognised even when you reach it through the
machine's LAN address rather than `localhost`.

---

## Testing it

### 1. Add a connection (the happy path)

1. Dashboard → **Providers** → open a provider from the table further down
   (e.g. `gemini-web`).
2. **Add connection**. The **"Sign in with browser"** panel is the first thing
   in the dialog; the manual instructions are collapsed behind a
   **"Manual paste"** row.
3. Click **Sign in with browser**. A browser window opens at the provider's
   sign-in page **on the OmniRoute host**, in the same browser family the
   dashboard is running in (see **Which browser opens**).
4. Sign in. The window closes by itself as soon as the credential appears.
5. The dashboard is back on the connection list with the new connection in it.

**Expect:** one connection, named as in the **Name** field, `testStatus: active`,
and no "Save" click anywhere.

### 2. Verify what was stored

The captured value is stored twice: encrypted in `api_key`, and mirrored in
plaintext JSON in `provider_specific_data` (the mirror is what makes the
credential inspectable).

```bash
sqlite3 "$DATA_DIR/storage.sqlite" \
  "SELECT provider, name,
          json_extract(provider_specific_data, '$.cookie') AS cookie
     FROM provider_connections
    WHERE provider = 'gemini-web';"
```

`$DATA_DIR` defaults to `~/.omniroute` — so the default path is
`~/.omniroute/storage.sqlite`.

> This prints a **live session credential**. Treat the output as a secret — do
> not paste it into a ticket, a chat, or a screenshot.

**Expect the right shape:**

| Provider kind | `provider_specific_data` |
| ------------- | ------------------------ |
| cookie        | `cookie` = the **full `Cookie` header** (`a=1; b=2`) — not one value, not JSON |
| token         | the **bare token** (no `Bearer ` prefix) under the provider's storage key |

For a token provider, read the provider's own key instead of `cookie` —
`token` for `kimi-web`, `zai-web`, `copilot-web`, `deepseek-web` and
`t3-chat-web`; `userToken` also works for `deepseek-web`, and `cookie` /
`kimi-auth` are extra mirrors for `kimi-web`.

A JSON blob (`{"sessionKey":"abc"}`) in that column means the capture went
through the old, broken path — report it.

### 3. Re-sync without signing in again

Open **Edit** on the connection → **Re-sync session**, at the top of the
dialog.

**Expect:** a toast, the dialog closes, the stored credential is refreshed.
When the saved browser profile is still signed in, the capture completes
without any interaction. Cookie providers finish immediately; token providers
wait out a short grace period (3–5 s) so the page has time to expose its
`localStorage`.

### 4. Force a fresh sign-in

The saved browser profile is what makes a re-sync silent. To force the full
sign-in flow again, delete it:

```bash
rm -rf "$DATA_DIR/browser-profiles/<provider>"
```

(`$DATA_DIR` defaults to `~/.omniroute`, so the default path is
`~/.omniroute/browser-profiles/<provider>`.)

The next **Re-sync session** opens a signed-out window.

### 5. Expired session

Sign out at the provider (or let the session expire), then click
**Re-sync session**.

**Expect:** the request fails with

> The saved browser session for this provider has expired. Run the sign-in
> again to refresh it.

The stale browser profile is deleted, and the **dead credential is not
re-stored** — the previous working value stays until a real sign-in replaces
it. A probe that cannot reach the provider is treated as inconclusive and
never invalidates a working session.

This check runs when the saved profile was reused (the re-sync found the
session already sitting in it) **and** the provider authenticates with a
cookie. Token providers are never judged this way: the shared probe sends the
credential as a `Cookie` header, so a bare token would come back 401 and be
wrongly reported as expired.

### 6. Headless host

On a server with no display the browser cannot open. The button reports it
plainly:

> The OmniRoute host has no display, so the sign-in browser cannot open. Run
> OmniRoute on a desktop machine, or start it with a virtual display (for
> example `xvfb-run npm run dev`), or paste the session credential manually.

To test the flow on a headless box, run OmniRoute under a virtual display:

```bash
xvfb-run -a npm run dev
```

### 7. Manual fallback

Click **"Manual paste"** in the add dialog — the four-step DevTools
instructions expand in place. Pasting a credential still validates it against
the provider, so a bad value is reported instead of silently stored.

---

## Re-syncing without signing in again

OmniRoute keeps a **separate browser profile per provider**, under the
OmniRoute data directory:

```
<DATA_DIR>/browser-profiles/<provider>/
```

That profile holds the live web session, so a later **Re-sync session** reuses
it: if the session is still valid, the capture completes on its own. Only when
the provider has expired the session do you have to sign in again — and then
the window that opens is already signed out, so the normal sign-in flow runs.

When every cookie the provider declares is already in the profile, OmniRoute
skips the minimum-login grace period and returns immediately.

The profile is created with owner-only permissions. To opt out and use a
throw-away session every time, set:

```bash
OMNIROUTE_WEB_SESSION_PROFILE=off
```

## Which providers support it

The button appears for every provider that has **both** a token-extraction
config (the sign-in URL and the credential to look for) **and** a web-session
credential requirement (the provider really does authenticate with a browser
session). Both live in the source of truth:

- `open-sse/services/tokenExtractionConfig.ts` — the login URL and the token
  sources.
- `src/shared/providers/webSessionCredentials.ts` — the credential kind and
  storage keys.

| Provider | Kind | Sign-in page |
| -------- | ---- | ------------ |
| `claude-web` | cookie | `https://claude.ai/login` |
| `gemini-web` | cookie | `https://gemini.google.com/app` |
| `grok-web` | cookie | `https://grok.com/login` |
| `perplexity-web` | cookie | `https://www.perplexity.ai/login` |
| `blackbox-web` | cookie | `https://app.blackbox.ai/login` |
| `adapta-web` | cookie | `https://agent.adapta.one/login` |
| `chatglm-web` | cookie | `https://chatglm.cn/` |
| `doubao-web` | cookie | `https://www.dola.com/` |
| `duckduckgo-web` | cookie | `https://duckduckgo.com/?q=DuckDuckGo+AI+Chat&ia=chat&duckai=1` |
| `manus-web` | cookie | `https://manus.im/login` |
| `muse-spark-web` | cookie | `https://www.meta.ai/` |
| `poe-web` | cookie | `https://poe.com/login` |
| `v0-vercel-web` | cookie | `https://v0.dev/login` |
| `venice-web` | cookie | `https://venice.ai/login` |
| `xiaomimimo-web` | cookie | `https://aistudio.xiaomimimo.com/login` |
| `deepseek-web` | token | `https://chat.deepseek.com/sign_in` |
| `kimi-web` | token | `https://www.kimi.com/` |
| `copilot-web` | token | `https://copilot.microsoft.com/` |
| `zai-web` | token | `https://chat.z.ai/` |
| `t3-chat-web` | token | `https://t3.chat/login` |

The providers with a dedicated sign-in flow of their own (Adobe Firefly's
system-Chrome capture, MaxAI's email device-pair, Conol's dedicated browser
login, the Volcano Engine console) keep their own flows and do not show the
generic button. `notion-web` has no known sign-in URL — use the manual paste
for it.

## What gets stored

The captured value is normalised into the shape the provider's executor
actually reads, so a successful sign-in is a usable credential rather than a
blob:

| Provider kind | Stored in `apiKey`                      | Stored in `providerSpecificData`      |
| ------------- | --------------------------------------- | ------------------------------------- |
| Cookie        | the full `Cookie` header (`a=1; b=2`)  | `cookie` (same header) + storage keys  |
| Token         | the bare token (no `Bearer ` prefix)    | the token under the provider's keys    |

Cookie capture takes **every cookie on the provider's domain**, not just the
one the provider declares. Providers rely on companion cookies — Grok needs
`sso` *and* `sso-rw`, and Cloudflare's `cf_clearance` is pinned to the browser
that earned it — so a partial capture would sign in successfully and then be
rejected upstream.

Credentials are encrypted at rest in the same place as every other provider
credential.

## Manual paste still works

The manual path is unchanged and remains the fallback for providers without a
known sign-in flow, for headless hosts, and for anyone who prefers it. When
browser sign-in is available, the manual instructions are collapsed behind a
**"Manual paste"** row so the one-click route stays the obvious choice; the
credential field itself stays visible, and a captured session is also written
into it — so a failed automatic save can be retried from the form.

## Troubleshooting

| Symptom                                              | What it means                                                                             |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| "Browser sign-in is not available for '<provider>'"   | No token-extraction config for that provider — paste the credential manually.               |
| "The OmniRoute host has no display…"                  | The host is headless, so the sign-in browser cannot open. Use a virtual display (`xvfb-run npm run dev`) or paste the credential manually. |
| "Login timed out"                                    | The credential never appeared in the browser session. The capture waits up to 5 minutes (2 for `duckduckgo-web`, `t3-chat-web`) — sign in again and retry. |
| "The browser session did not yield a usable credential" | The session was captured but the provider expected a different credential kind.           |
| "The saved browser session for this provider has expired." | The provider rejected the saved session. The stale profile was deleted — sign in again. |
| The browser window does not appear                    | The OmniRoute host has no display (headless server). Use the manual paste, or run with a virtual display. |
| The capture succeeds but requests 401                 | The stored value is not the shape the executor reads. Check `provider_specific_data.cookie` (see **Verify what was stored**). |
| A Firefox window opens when you expected Chrome      | The window follows the browser the **dashboard** is in, not the host's default. Sign in from a Chrome tab if you want Chrome. |
| The window opens in a browser you do not recognise    | The dashboard's browser could not be identified, so the host's default browser was used. The panel names it — if that is wrong, open the dashboard in your usual browser. |
| "Could not download the Firefox build…"               | The host could not fetch the browser build (network or disk space). The download is retried on the next sign-in; the host caches it once it succeeds. |
| The window opens in a browser you do not have accounts in | The browser was started fresh with a dedicated profile, so it has none of your accounts. Sign in once — the profile is kept, so later re-syncs need no password. |
| The sign-in opens a different browser than the dashboard | The dashboard is served from another machine, so its browser says nothing about what the host can open. The host uses its own default browser in that case. |

## Related

- [`docs/security/ROUTE_GUARD_TIERS.md`](../security/ROUTE_GUARD_TIERS.md) — both sign-in
  endpoints are `LOCAL_ONLY`: they launch a browser, so they only run for loopback callers.
- `open-sse/services/inAppLoginService.ts` — the capture service.
- `src/lib/providers/webSessionCredentialPayload.ts` — the credential normaliser.
- `src/lib/providers/webSessionCapture.ts` — the stale-session probe.
