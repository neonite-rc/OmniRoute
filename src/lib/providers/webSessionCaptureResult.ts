/**
 * Turns a raw browser-login result into the canonical capture response.
 *
 * The browser login produces the raw extraction map (cookie name → value) and
 * the provider-domain cookie jar. Neither is a credential the executors can
 * use: perplexity-web and grok-web read `credentials.apiKey` as a Cookie
 * header and claude-web reads `providerSpecificData.cookie`.
 *
 * Both the native sign-in (a window on the host) and the streamed sign-in
 * (the view shown inside the dashboard) end up here, so both hand the
 * dashboard exactly the same payload.
 */

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

export interface WebSessionCaptureSuccess {
  success: true;
  credential: string;
  apiKey?: string;
  providerSpecificData: Record<string, unknown>;
  alreadySignedIn: boolean;
}

export interface WebSessionCaptureFailure {
  success: false;
  error: string;
}

export type WebSessionCaptureResult = WebSessionCaptureSuccess | WebSessionCaptureFailure;

/**
 * Build the capture response for a finished browser login.
 *
 * A capture that reused the saved browser profile can hand back a session the
 * provider has since invalidated. That is probed before the credential is
 * handed to the dashboard, and the stale profile is dropped so the next
 * attempt asks for a real sign-in.
 */
export async function buildWebSessionCaptureResult(
  provider: string,
  result: LoginResult
): Promise<WebSessionCaptureResult> {
  if (!result.success || !result.credentials) {
    // A captcha that blocked the sign-in is recorded so the dashboard can
    // prompt when it keeps coming back — the operator sees "timed out"
    // otherwise, with no hint about what to fix.
    if (result.errorCode === "captcha_required") {
      noteCaptchaBlocked(provider, result.error);
    }
    return {
      success: false,
      // Hard Rule #12: the browser failure may still carry a raw Playwright
      // dump — never ship it to the dashboard as-is.
      error: sanitizeErrorMessage(result.error) || "Sign-in did not complete",
    };
  }

  const payload = buildWebSessionCredentialPayload({
    providerId: provider,
    extracted: result.credentials,
    cookies: result.cookies,
  });

  if (!payload.credential) {
    return {
      success: false,
      error:
        "The browser session did not yield a usable credential for this provider. Sign in again and retry.",
    };
  }

  if (result.alreadySignedIn) {
    const validation = await capturedSessionProbe.validate(provider, payload);
    if (validation.challengeBlocked) {
      // The provider refused the probe with an anti-bot challenge, not with an
      // auth rejection. The session behind it may still be alive, so the
      // saved profile is KEPT — wiping it would throw away a working sign-in
      // over a challenge the operator can solve.
      noteCaptchaBlocked(provider, "The provider refused the saved session with a bot challenge.");
      return {
        success: false,
        error:
          "The provider is currently blocking OmniRoute with a captcha / anti-bot challenge. " +
          "Solve it in the sign-in window and run the sign-in again — the saved session was kept.",
      };
    }
    if (validation.expired) {
      // A definitive 401/403: the session really is dead, so the stale
      // profile is dropped and the next attempt asks for a real sign-in.
      noteSessionExpired(provider, "The provider rejected the saved browser session.");
      clearBrowserProfile(provider);
      return {
        success: false,
        error:
          "The saved browser session for this provider has expired. Run the sign-in again to refresh it.",
      };
    }
  }

  // The sign-in worked — any open problem for this provider is solved.
  noteSessionHealthy(provider);

  return {
    success: true,
    credential: payload.credential,
    apiKey: payload.apiKey,
    providerSpecificData: payload.providerSpecificData,
    alreadySignedIn: result.alreadySignedIn === true,
  };
}
