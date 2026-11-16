"use client";

/**
 * WebSessionBrowserSignIn — one-click browser sign-in for web-session providers.
 *
 * The fast path: the operator clicks the button, a browser opens at the
 * provider's login page, they sign in as usual, and OmniRoute captures the
 * resulting session (Cookie header / localStorage token) and stores it on the
 * connection. No DevTools, no copying a Cookie header by hand.
 *
 * WHERE THE SIGN-IN HAPPENS: the button opens a NEW TAB in the very browser
 * the dashboard is running in (`/dashboard/providers/web-session-signin`).
 * That tab runs the sign-in — a window on the OmniRoute host when the host has
 * a display, or the streamed view of the host's browser when it does not (a
 * headless host, or a dashboard open on another machine) — and hands the
 * captured session back to this tab. So the sign-in always happens where the
 * operator is looking.
 *
 * This mirrors Proxima's model, where each provider owns a persistent browser
 * session partition: the browser profile is kept under the OmniRoute data
 * directory, so a later "Re-sync" reuses the still-valid session and completes
 * without another sign-in.
 *
 * The manual paste path stays available as a fallback — see
 * `WebSessionCredentialGuide`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Button from "@/shared/components/Button";
import { getExtractionConfig } from "@omniroute/open-sse/services/tokenExtractionConfig.ts";
import { providerText, type ProviderMessageTranslator } from "../providerPageHelpers";
import { requiresWebSessionCredential } from "../webSessionCredentials";
import { detectBrowserFamily, type BrowserFamily } from "@/shared/providers/browserFamily";
import {
  isWebSessionSigninResult,
  type WebSessionSigninResult,
} from "@/lib/providers/webSessionSigninMessage";

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
  // "signing-in" = the sign-in tab is open and we wait for the operator.
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
    /**
     * Where the sign-in appears:
     *  - "native" — a browser window opens on this machine (the dashboard runs
     *    on the OmniRoute host, which has a display);
     *  - "streamed" — the host has no display, or the dashboard is open on
     *    another machine, so the sign-in is streamed into the sign-in tab.
     */
    signInMode: "native" | "streamed";
  } | null>(null);

  // The sign-in tab the dashboard opened.
  const signinTabRef = useRef<Window | null>(null);

  useEffect(() => {
    // No button means no sign-in window — do not ask the server about it.
    if (!supportsBrowserSignIn(provider)) return;
    if (mode === "sync" && !connectionId) return;

    let cancelled = false;
    const query =
      browserFamily === "unknown" ? "" : `?browser=${encodeURIComponent(browserFamily)}`;
    fetch(`/api/providers/web-session-browser${query}`)
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (
          data: {
            browserName?: unknown;
            usesRunningBrowser?: unknown;
            browserBuildReady?: unknown;
            signInMode?: unknown;
          } | null
        ) => {
          if (cancelled || !data) return;
          setBrowserInfo({
            name: typeof data.browserName === "string" ? data.browserName : "",
            running: data.usesRunningBrowser === true,
            buildReady: data.browserBuildReady !== false,
            signInMode: data.signInMode === "streamed" ? "streamed" : "native",
          });
        }
      )
      .catch(() => {
        // The browser name is a nicety — the sign-in still works without it.
      });

    return () => {
      cancelled = true;
    };
  }, [provider, mode, connectionId, browserFamily]);

  // A re-sync persists straight onto an existing connection. Without a
  // connection id there is nothing to persist onto, and falling back to the
  // capture endpoint would hand the credential to nobody — so offer nothing.
  const supported = supportsBrowserSignIn(provider) && !(mode === "sync" && !connectionId);

  /**
   * Apply a captured session — the same handling for the native sign-in and
   * for the streamed one.
   */
  const applyCapturedSession = useCallback(
    async (data: {
      credential?: string;
      providerSpecificData?: Record<string, unknown>;
      alreadySignedIn?: boolean;
    }) => {
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
    },
    [onCaptured, t]
  );

  /** The sign-in tab handed the captured session back. */
  const handleSigninResult = useCallback(
    async (result: WebSessionSigninResult) => {
      signinTabRef.current = null;

      if (!result.success) {
        setError(
          result.error ||
            providerText(
              t,
              "webSessionBrowserSignInFailed",
              "Browser sign-in did not complete. Try again, or paste the credential manually."
            )
        );
        setPhase("idle");
        return;
      }

      if (mode === "sync") {
        setPhase("saving");
        await onSynced?.({ alreadySignedIn: result.alreadySignedIn === true });
        setPhase("idle");
        return;
      }

      await applyCapturedSession(result);
      setPhase("idle");
    },
    [mode, onSynced, applyCapturedSession, t]
  );

  // The sign-in tab posts the outcome back to this tab.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Same-origin only — the sign-in tab runs on this very site.
      if (event.origin !== window.location.origin) return;
      if (!isWebSessionSigninResult(event.data)) return;
      void handleSigninResult(event.data);
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [handleSigninResult]);

  // A sign-in tab that is closed before it reports back leaves the panel
  // waiting forever — notice it and let the operator try again.
  useEffect(() => {
    if (phase !== "signing-in") return;
    const timer = setInterval(() => {
      const tab = signinTabRef.current;
      if (!tab || !tab.closed) return;
      signinTabRef.current = null;
      setError(
        providerText(
          t,
          "webSessionSigninTabClosed",
          "The sign-in tab was closed before the session was captured. Try again."
        )
      );
      setPhase("idle");
    }, 1000);
    return () => clearInterval(timer);
  }, [phase, t]);

  /**
   * Open the sign-in in a NEW TAB of this browser.
   *
   * The tab runs the sign-in wherever it has to happen — on the OmniRoute host
   * when the host has a display, or streamed into the tab when it does not —
   * and reports the captured session back.
   */
  const handleSignIn = () => {
    setError(null);

    const params = new URLSearchParams();
    params.set("provider", provider);
    params.set("name", providerName);
    params.set("mode", mode);
    if (connectionId) params.set("connectionId", connectionId);

    const tab = window.open(
      `/dashboard/providers/web-session-signin?${params.toString()}`,
      "_blank"
    );
    if (!tab) {
      setError(
        providerText(
          t,
          "webSessionSigninTabBlocked",
          "Your browser blocked the sign-in tab. Allow pop-ups for this site and try again."
        )
      );
      return;
    }

    signinTabRef.current = tab;
    setPhase("signing-in");
  };

  const streamed = browserInfo?.signInMode === "streamed";

  // Nothing to offer for this provider (or an impossible re-sync): render
  // nothing. The hooks above still ran, so the hook order never changes.
  if (!supported) return null;

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
              : streamed
                ? providerText(
                    t,
                    "webSessionBrowserSignInBodyRemote",
                    "A new tab opens in this browser with the sign-in page live from the OmniRoute host, so you sign in on this screen even when OmniRoute runs on another machine.",
                    { provider: providerName }
                  )
                : providerText(
                    t,
                    "webSessionBrowserSignInBody",
                    "A new tab opens in this browser and a sign-in window appears on this machine. Sign in to {provider} there and OmniRoute captures the session for you — no copying cookies from DevTools.",
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
                : providerText(t, "webSessionBrowserOpens", "Opens in {browser}.", {
                    browser: browserInfo.name,
                  })}
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
