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

import { useState } from "react";
import Button from "@/shared/components/Button";
import { getExtractionConfig } from "@omniroute/open-sse/services/tokenExtractionConfig.ts";
import { providerText, type ProviderMessageTranslator } from "../providerPageHelpers";

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
  onCaptured?: (session: WebSessionCapturedSession) => void;
  onSynced?: (session: { alreadySignedIn: boolean }) => void;
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
 * Requires an extraction config (the login URL + the token sources to look
 * for). A provider without one has no known login flow, so the button stays
 * hidden and the manual paste remains the only option.
 */
export function supportsBrowserSignIn(providerId: string): boolean {
  if (!providerId) return false;
  if (DEDICATED_FLOW_PROVIDERS.has(providerId)) return false;
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!supportsBrowserSignIn(provider)) return null;

  // A re-sync persists straight onto an existing connection. Without a
  // connection id there is nothing to persist onto, and falling back to the
  // capture endpoint would hand the credential to nobody — so offer nothing.
  if (mode === "sync" && !connectionId) return null;

  const handleSignIn = async () => {
    setBusy(true);
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
          body: JSON.stringify(isSync ? {} : { provider }),
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
        onSynced?.({ alreadySignedIn: data.alreadySignedIn === true });
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

      onCaptured?.({
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
      setBusy(false);
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
        </div>
        <Button size="sm" icon="login" loading={busy} onClick={handleSignIn} disabled={busy}>
          {busy
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
