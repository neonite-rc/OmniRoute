/**
 * POST /api/providers/web-session-login
 *
 * Browser sign-in for web-session providers — the capture-only variant used
 * while ADDING a connection.
 *
 * Opens a browser at the provider's login page, waits for the operator to sign
 * in, captures the resulting session (Cookie header / localStorage token) and
 * returns it in the canonical credential shape. Nothing is persisted here: the
 * dashboard pre-fills the credential field and the operator saves the
 * connection through the normal add-connection flow, so the existing
 * validation and audit paths still apply.
 *
 * WHERE THE WINDOW APPEARS depends on where the dashboard is:
 *
 *  - The dashboard is open on the OmniRoute host → the browser opens as a
 *    window on that machine, in the browser family the dashboard reported.
 *  - The dashboard is open on another machine (a laptop driving a headless
 *    server on the LAN) → the host runs the browser without a display and
 *    streams the view into the dashboard, so the operator signs in on their
 *    own screen. The route answers with `{ mode: "stream", sessionId }` and
 *    the dashboard follows the event stream at
 *    `/api/providers/web-session-login/stream`.
 *
 * The companion `POST /api/providers/{id}/login` route persists straight onto
 * an existing connection — that is the "re-sync" path.
 *
 * Security: this route launches a headful Chromium (a child process), so it
 * is classified LOCAL_ONLY in `src/server/authz/routeGuard.ts` — loopback
 * enforcement runs before any auth check, so a leaked JWT via a tunnel cannot
 * trigger a browser spawn (Hard Rules #15 + #17). A private-LAN peer is
 * allowed (owner-authorized), which is what makes the streamed flow work from
 * another machine on the same network.
 */

import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { clampLoginTimeoutMs } from "@/lib/api/loginTimeout";
import { buildWebSessionCaptureResult } from "@/lib/providers/webSessionCaptureResult";
import { getWebSessionCredentialRequirement } from "@/shared/providers/webSessionCredentials";
import { webSessionLoginSchema } from "@/shared/validation/schemas";
import { resolveBrowserHintForRequest, resolveSignInMode } from "@/lib/api/browserHint";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateBody(webSessionLoginSchema, body);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const { provider } = validation.data;

  // Only providers with a declared extraction config can be captured — the
  // config carries the login URL and the token sources to look for.
  const { getExtractionConfig } =
    await import("@omniroute/open-sse/services/tokenExtractionConfig.ts");
  const extractionConfig = getExtractionConfig(provider);
  if (!extractionConfig) {
    return NextResponse.json(
      {
        error: `Browser sign-in is not available for '${provider}'. Paste the session credential manually instead.`,
      },
      { status: 400 }
    );
  }

  const requirement = getWebSessionCredentialRequirement(provider);
  if (!requirement || requirement.kind === "none") {
    return NextResponse.json(
      { error: `Provider '${provider}' does not use a web-session credential` },
      { status: 400 }
    );
  }

  try {
    const { inAppLoginService, hostHasDisplay, isDisplayUnavailableError } =
      await import("@omniroute/open-sse/services/inAppLoginService.ts");

    const timeout = clampLoginTimeoutMs(validation.data.timeout);
    // The dashboard reports the browser it detected in its own user agent,
    // so the sign-in window opens in the browser the operator is using —
    // but only when the dashboard is open on this very host. A dashboard
    // served to another machine says nothing about what this host can open.
    const browser = resolveBrowserHintForRequest(request, validation.data.browser ?? "unknown");

    // Where does the window have to appear? In front of the operator.
    //
    //  - The dashboard is open on another machine → a window on this host
    //    would be invisible to them, so the view is streamed into the
    //    dashboard instead.
    //  - This host has no display → same thing; a window cannot open at all.
    const streamed = resolveSignInMode(request, hostHasDisplay()) === "streamed";

    if (streamed) {
      const { startStreamedLogin } =
        await import("@omniroute/open-sse/services/webSessionStreamService.ts");
      const { sessionId } = await startStreamedLogin(provider, { timeout, browser });
      return NextResponse.json({
        success: true,
        mode: "stream",
        sessionId,
        provider,
      });
    }

    const result = await inAppLoginService.startLogin(provider, { timeout, browser });

    // The host turned out to have no display after all (a stale DISPLAY, a
    // container without /tmp/.X11-unix). Fall back to the streamed view so the
    // operator still gets a sign-in window.
    if (!result.success && isDisplayUnavailableError(result.error)) {
      const { startStreamedLogin } =
        await import("@omniroute/open-sse/services/webSessionStreamService.ts");
      const { sessionId } = await startStreamedLogin(provider, { timeout, browser });
      return NextResponse.json({
        success: true,
        mode: "stream",
        sessionId,
        provider,
      });
    }

    const payload = await buildWebSessionCaptureResult(provider, result);
    // `success === false` (not `!success`) — the truthiness form does not
    // narrow the union with strictNullChecks off, which this project uses.
    if (payload.success === false) {
      return NextResponse.json(
        {
          success: false,
          // Hard Rule #12: the service's own error may still carry a raw
          // browser/Playwright dump — never ship it to the dashboard as-is.
          error: sanitizeErrorMessage(payload.error) || "Sign-in did not complete",
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      persisted: false,
      provider,
      credential: payload.credential,
      apiKey: payload.apiKey,
      providerSpecificData: payload.providerSpecificData,
      alreadySignedIn: payload.alreadySignedIn,
    });
  } catch (err) {
    // Hard Rule #12: never put raw err.message/stack in a response body.
    const msg = sanitizeErrorMessage(err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
