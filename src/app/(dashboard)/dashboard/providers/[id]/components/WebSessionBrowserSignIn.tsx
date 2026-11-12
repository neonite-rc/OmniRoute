"use client";

/**
 * WebSessionBrowserSignIn — one-click browser sign-in for web-session providers.
 *
 * The fast path: the operator clicks the button, a browser opens at the
 * provider's login page, they sign in as usual, and OmniRoute captures the
 * resulting session (Cookie header / localStorage token) and stores it on the
 * connection. No DevTools, no copying a Cookie header by hand.
 *
 * This mirrors Proxima's model, where each provider owns a persistent browser
 * session partition: the browser profile is kept under the OmniRoute data
 * directory, so a later "Re-sync" reuses the still-valid session and completes
 * without another sign-in.
 *
 * The manual paste path stays available as a fallback — see
 * `WebSessionCredentialGuide`.
 */

import { useEffect, useState } from "react";
import Button from "@/shared/components/Button";
import { getExtractionConfig } from "@omniroute/open-sse/services/tokenExtractionConfig.ts";
import { providerText, type ProviderMessageTranslator } from "../providerPageHelpers";
import { requiresWebSessionCredential } from "../webSessionCredentials";
import { detectBrowserFamily, type BrowserFamily } from "@/shared/providers/browserFamily";

export interface WebSessionCapturedSession {
  /** The canonical credential string (Cookie header or bare token). */
  credential: string;
  /** Structured session data to store alongside the credential. */
  providerSpecificData: Record<string, unknown>;
  /** True when the session was reused from the saved browser profile. */
  alreadySignedIn: boolean;
}

export interface WebSessionBrowserSignInProps {
  provider: string;
  providerName: string;
  /**
   * "add" captures the session and hands it back for the form to pre-fill;
   * "sync" captures it and persists it straight onto an existing connection.
   */
  mode: "add" | "sync";
  /** Required in "sync" mode — the connection to persist onto. */
  connectionId?: string;
  onCaptured?: (session: WebSessionCapturedSession) => void | Promise<void>;
  onSynced?: (session: { alreadySignedIn: boolean }) => void | Promise<void>;
  t: ProviderMessageTranslator;
}

/**
 * Providers whose sign-in has its own dedicated flow (own modal, own route
 * branch, or a provider-specific capture such as Adobe's IMS JWT). The generic
 * browser sign-in must not shadow those.
 */
const DEDICATED_FLOW_PROVIDERS = new Set([
  "maxai",
  "mx",
  "adobe-firefly",
  "firefly",
  "conol-web",
  "cnl",
  "volcengine-console",
]);

/**
 * Whether the generic browser sign-in is offered for a provider.
 *
 * Requires a token-extraction config (the login URL + the token sources to look
 * for) AND a web-session credential requirement (the provider really does
 * authenticate with a browser session). The second condition matters: an
 * extraction config alone is not enough — `veoaifree-web` has one but is a
 * video provider that uses an API key, and capturing a cookie for it would
 * store the wrong credential.
 *
 * A provider without a known login flow has no button, and the manual paste
 * remains the only option.
 */
export function supportsBrowserSignIn(providerId: string): boolean {
  if (!providerId) return false;
  if (DEDICATED_FLOW_PROVIDERS.has(providerId)) return false;
  if (!requiresWebSessionCredential(providerId)) return false;
  return !!getExtractionConfig(providerId);
}

export default function WebSessionBrowserSignIn({
  provider,
  providerName,
  mode,
  connectionId,
  onCaptured,
  onSynced,
  t,
}: WebSessionBrowserSignInProps) {
  // "signing-in" = the browser window is open and we wait for the operator.
  // "saving" = the session was captured and the connection is being written.
  const [phase, setPhase] = useState<"idle" | "signing-in" | "saving">("idle");
  const [error, setError] = useState<string | null>(null);
  const busy = phase !== "idle";

  // The browser the operator is looking at right now. The sign-in window
  // opens in that same browser, so they sign in where they already are —
  // their own Firefox with their accounts, not a foreign Chromium.
  //
  // Read once at mount: the user agent does not change while the page is
  // open, and the server has to be told before the capture starts.
  const [browserFamily] = useState<BrowserFamily>(() =>
    typeof navigator === "undefined" ? "unknown" : detectBrowserFamily(navigator.userAgent)
  );
  // The browser the OmniRoute host will actually open, and whether it is the
  // operator's own already-running browser.
  const [browserInfo, setBrowserInfo] = useState<{
    name: string;
    running: boolean;
    buildReady: boolean;
  } | null>(null);

  useEffect(() => {
    // No button means no sign-in window — do not ask the server about it.
    if (!supportsBrowserSignIn(provider)) return;
    if (mode === "sync" && !connectionId) return;

    let cancelled = false;
    const query = browserFamily === "unknown" ? "" : `?browser=${encodeURIComponent(browserFamily)}`;
    fetch(`/api/providers/web-session-browser${query}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: {
        browserName?: unknown;
        usesRunningBrowser?: unknown;
        browserBuildReady?: unknown;
      } | null) => {
        if (cancelled || !data) return;
        setBrowserInfo({
          name: typeof data.browserName === "string" ? data.browserName : "",
          running: data.usesRunningBrowser === true,
          buildReady: data.browserBuildReady !== false,
        });
      })
      .catch(() => {
        // The browser name is a nicety — the sign-in still works without it.
      });

    return () => {
      cancelled = true;
    };
  }, [provider, mode, connectionId, browserFamily]);

  if (!supportsBrowserSignIn(provider)) return null;

  // A re-sync persists straight onto an existing connection. Without a
  // connection id there is nothing to persist onto, and falling back to the
  // capture endpoint would hand the credential to nobody — so offer nothing.
  if (mode === "sync" && !connectionId) return null;

  const handleSignIn = async () => {
    setPhase("signing-in");
    setError(null);
    try {
      const isSync = mode === "sync" && !!connectionId;
      const response = await fetch(
        isSync
          ? `/api/providers/${encodeURIComponent(connectionId)}/login`
          : "/api/providers/web-session-login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(isSync ? { browser: browserFamily } : { provider, browser: browserFamily }),
        }
      );
      const data = (await response.json().catch(() => null)) as
        (WebSessionCapturedSession & { success?: boolean; error?: string }) | null;

      if (!response.ok || !data?.success) {
        setError(
          data?.error ||
            providerText(
              t,
              "webSessionBrowserSignInFailed",
              "Browser sign-in did not complete. Try again, or paste the credential manually."
            )
        );
        return;
      }

      if (isSync) {
        setPhase("saving");
        await onSynced?.({ alreadySignedIn: data.alreadySignedIn === true });
        return;
      }

      if (typeof data.credential !== "string" || !data.credential) {
        setError(
          providerText(
            t,
            "webSessionBrowserSignInEmpty",
            "The browser session did not yield a credential. Sign in again and retry."
          )
        );
        return;
      }

      setPhase("saving");
      await onCaptured?.({
        credential: data.credential,
        providerSpecificData:
          data.providerSpecificData && typeof data.providerSpecificData === "object"
            ? data.providerSpecificData
            : {},
        alreadySignedIn: data.alreadySignedIn === true,
      });
    } catch {
      setError(
        providerText(
          t,
          "webSessionBrowserSignInFailed",
          "Browser sign-in did not complete. Try again, or paste the credential manually."
        )
      );
    } finally {
      setPhase("idle");
    }
  };

  return (
    <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-3 text-sm text-text-muted">
      <div className="space-y-2">
        <div>
          <p className="font-medium text-text-main">
            {mode === "sync"
              ? providerText(t, "webSessionResyncTitle", "Refresh the saved {provider} session", {
                  provider: providerName,
                })
              : providerText(
                  t,
                  "webSessionBrowserSignInTitle",
                  "Sign in to {provider} in a browser",
                  { provider: providerName }
                )}
          </p>
          <p className="mt-1">
            {mode === "sync"
              ? providerText(
                  t,
                  "webSessionResyncBody",
                  "OmniRoute reuses the browser profile it saved for {provider}. If the session is still valid it is refreshed automatically; otherwise sign in again in the window that opens.",
                  { provider: providerName }
                )
              : providerText(
                  t,
                  "webSessionBrowserSignInBody",
                  "A browser window opens on this machine. Sign in to {provider} there and OmniRoute captures the session for you — no copying cookies from DevTools.",
                  { provider: providerName }
                )}
          </p>
          {browserInfo?.name && (
            <p className="mt-1 text-xs opacity-80">
              {browserInfo.running
                ? providerText(
                    t,
                    "webSessionBrowserRunning",
                    "Uses the {browser} that is already running — you are signed in there already.",
                    { browser: browserInfo.name }
                  )
                : providerText(
                    t,
                    "webSessionBrowserOpens",
                    "Opens in {browser}.",
                    { browser: browserInfo.name }
                  )}
              {!browserInfo.running && !browserInfo.buildReady && (
                <>
                  {" "}
                  {providerText(
                    t,
                    "webSessionBrowserDownload",
                    "The OmniRoute host downloads it on the first sign-in — there is nothing to install on your side.",
                    { browser: browserInfo.name }
                  )}
                </>
              )}
            </p>
          )}
        </div>
        <Button size="sm" icon="login" loading={busy} onClick={handleSignIn} disabled={busy}>
          {phase === "saving"
            ? providerText(t, "webSessionConnecting", "Connecting…")
            : phase === "signing-in"
              ? providerText(t, "webSessionBrowserSignInWaiting", "Waiting for sign-in…")
              : mode === "sync"
                ? providerText(t, "webSessionResyncButton", "Re-sync session")
                : providerText(t, "webSessionBrowserSignInButton", "Sign in with browser")}
        </Button>
        {error && <p className="text-xs text-rose-400">{error}</p>}
      </div>
    </div>
  );
}
