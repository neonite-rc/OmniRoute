---
title: "Web-session providers — browser sign-in"
version: 3.8.51
lastUpdated: 2026-11-04
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
   provider's credential appears.
5. The credential is pre-filled in the form. Click **Add connection** to save it.

For an existing connection, open **Edit** and click **Re-sync session** — the
new session is stored directly on the connection, with no copy/paste step.

> **The browser opens on the OmniRoute host**, not in your dashboard tab. On a
> desktop install that is your own machine. On a remote/server deployment it is
> the server's display — sign in there, or fall back to pasting the credential.

## Re-syncing without signing in again

OmniRoute keeps a **separate browser profile per provider**, under the
OmniRoute data directory:

```
<DATA_DIR>/browser-profiles/<provider>/
```

That profile holds the live web session, so a later **Re-sync session** reuses
it: if the session is still valid, the capture completes immediately and the
stored credential is refreshed. Only when the provider has expired the session
do you have to sign in again — and then the window that opens is already
signed out, so the normal sign-in flow runs.

The profile is created with owner-only permissions. To opt out and use a
throw-away session every time, set:

```bash
OMNIROUTE_WEB_SESSION_PROFILE=off
```

## Which providers support it

Browser sign-in is offered for every provider that has a **token-extraction
config** in `open-sse/services/tokenExtractionConfig.ts` — that config carries
the sign-in URL and the credential to look for (a cookie, a `localStorage`
entry, or a request header).

The providers with a dedicated sign-in flow of their own (Adobe Firefly's
system-Chrome capture, MaxAI's email device-pair, Conol's dedicated browser
login, the Volcano Engine console) keep their own flows and do not show the
generic button.

If a provider is not listed, OmniRoute cannot open the right sign-in page for
it — use the manual paste for that provider.

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
known sign-in flow, for headless hosts, and for anyone who prefers it. The
"Sign in with browser" panel sits above the manual instructions in the
credential dialog.

## Troubleshooting

| Symptom                                              | What it means                                                                             |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| "Browser sign-in is not available for '<provider>'"   | No token-extraction config for that provider — paste the credential manually.               |
| "Login timed out"                                    | The credential never appeared in the browser session. Sign in again, or raise the timeout.  |
| "The browser session did not yield a usable credential" | The session was captured but the provider expected a different credential kind.           |
| The browser window does not appear                    | The OmniRoute host has no display (headless server). Use the manual paste, or run with a virtual display. |

## Related

- [`docs/security/ROUTE_GUARD_TIERS.md`](../security/ROUTE_GUARD_TIERS.md) — both sign-in
  endpoints are `LOCAL_ONLY`: they launch a browser, so they only run for loopback callers.
- `open-sse/services/inAppLoginService.ts` — the capture service.
- `src/lib/providers/webSessionCredentialPayload.ts` — the credential normaliser.
