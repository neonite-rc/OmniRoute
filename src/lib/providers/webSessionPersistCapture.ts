/**
 * Persists a captured browser session onto an existing provider connection.
 *
 * The "Re-sync session" button captures a fresh browser session and stores it
 * straight onto the connection — the operator never sees the credential. The
 * same code runs for the native sign-in (a window on the host) and for the
 * streamed one (the view shown in the dashboard), so both paths store exactly
 * the same shape.
 *
 * The shape matters: the executors read the credential from
 * `credentials.apiKey` (a Cookie header or a bare token) and from
 * `providerSpecificData.cookie` — never from the raw extraction map. See
 * `webSessionCredentialPayload.ts`.
 */

import { getCachedProviderConnectionById } from "@/lib/db/readCache";
import { updateProviderConnection } from "@/lib/db/providers";
import { parseProviderSpecificData } from "@/lib/db/webSessionDedup";
import { buildWebSessionCredentialPayload } from "@/lib/providers/webSessionCredentialPayload";
import { capturedSessionProbe } from "@/lib/providers/webSessionCapture";
import {
  noteCaptchaBlocked,
  noteSessionExpired,
  noteSessionHealthy,
} from "@/lib/providers/webSessionCaptureIssues";
import { clearBrowserProfile } from "@omniroute/open-sse/services/inAppLoginService.ts";
import type { LoginResult } from "@omniroute/open-sse/services/inAppLoginService.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

export interface PersistedWebSessionCapture {
  /** True when the session was reused from the saved browser profile. */
  alreadySignedIn: boolean;
  /** The canonical credential string that was stored. */
  credential: string;
}

/**
 * A capture that cannot be stored because of the CAPTURE itself — nothing was
 * extracted, or the provider has invalidated the saved session.
 *
 * That is the operator's problem to fix (sign in again), not a server error:
 * the route answers with 400. A failure to WRITE the capture keeps the plain
 * error and is reported as a 500.
 */
export class WebSessionCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSessionCaptureError";
  }
}

/**
 * Store a captured browser session on a connection.
 *
 * Throws with an operator-facing message when the capture is unusable — the
 * caller turns that into the route's error response.
 */
export async function persistWebSessionCapture(params: {
  connectionId: string;
  /** Provider slug, e.g. "claude-web" — the extraction config is keyed by it. */
  provider: string;
  /** The raw result of the browser login. */
  result: LoginResult;
}): Promise<PersistedWebSessionCapture> {
  const { connectionId, provider, result } = params;

  if (!result.success || !result.credentials) {
    // A captcha that blocked the sign-in is recorded so the dashboard can
    // prompt when it keeps coming back.
    if (result.errorCode === "captcha_required") {
      noteCaptchaBlocked(provider, result.error);
    }
    // Hard Rule #12: the service's own error may still carry a raw
    // browser/Playwright dump — never ship it as-is.
    throw new WebSessionCaptureError(
      sanitizeErrorMessage(result.error) || "Sign-in did not complete"
    );
  }

  const payload = buildWebSessionCredentialPayload({
    providerId: provider,
    extracted: result.credentials,
    cookies: result.cookies,
  });

  if (!payload.credential) {
    throw new WebSessionCaptureError(
      "The browser session did not yield a usable credential for this provider. Sign in again and retry."
    );
  }

  // A re-sync that reused the saved browser profile can hand back a session
  // the provider has since invalidated. Probe it before storing it, and drop
  // the stale profile so the next attempt asks for a real sign-in.
  if (result.alreadySignedIn) {
    const validation = await capturedSessionProbe.validate(provider, payload);
    if (validation.challengeBlocked) {
      // A bot challenge is not an expiry: the saved profile is kept so the
      // operator can solve the challenge and re-sync without signing in from
      // scratch.
      noteCaptchaBlocked(provider, "The provider refused the saved session with a bot challenge.");
      throw new WebSessionCaptureError(
        "The provider is currently blocking OmniRoute with a captcha / anti-bot challenge. " +
          "Solve it in the sign-in window and run the sign-in again — the saved session was kept."
      );
    }
    if (validation.expired) {
      // A definitive 401/403: the session really is dead, so the stale
      // profile is dropped and the next attempt asks for a real sign-in.
      noteSessionExpired(provider, "The provider rejected the saved browser session.");
      clearBrowserProfile(provider);
      throw new WebSessionCaptureError(
        "The saved browser session for this provider has expired. Run the sign-in again to refresh it."
      );
    }
  }

  // Merge into the existing providerSpecificData: the captured session must
  // not wipe settings the operator configured on this connection (custom user
  // agent, proxy, quota thresholds, ...).
  const connection = await getCachedProviderConnectionById(connectionId);
  const existing = parseProviderSpecificData(
    (connection as Record<string, unknown> | null)?.providerSpecificData
  );

  await updateProviderConnection(connectionId, {
    apiKey: payload.apiKey,
    providerSpecificData: { ...(existing ?? {}), ...payload.providerSpecificData },
  });

  // The re-sync worked — any open problem for this provider is solved.
  noteSessionHealthy(provider);

  return {
    alreadySignedIn: result.alreadySignedIn === true,
    credential: payload.credential,
  };
}
