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
 * The companion `POST /api/providers/{id}/login` route persists straight onto
 * an existing connection — that is the "re-sync" path.
 *
 * Security: this route launches a headful Chromium (a child process), so it
 * is classified LOCAL_ONLY in `src/server/authz/routeGuard.ts` — loopback
 * enforcement runs before any auth check, so a leaked JWT via a tunnel cannot
 * trigger a browser spawn (Hard Rules #15 + #17).
 */

import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { clampLoginTimeoutMs } from "@/lib/api/loginTimeout";
import { buildWebSessionCredentialPayload } from "@/lib/providers/webSessionCredentialPayload";
import { getWebSessionCredentialRequirement } from "@/shared/providers/webSessionCredentials";
import { webSessionLoginSchema } from "@/shared/validation/schemas";
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
    const { inAppLoginService } = await import("@omniroute/open-sse/services/inAppLoginService.ts");

    const result = await inAppLoginService.startLogin(provider, {
      timeout: clampLoginTimeoutMs(validation.data.timeout),
      // The dashboard reports the browser it detected in its own user agent,
      // so the sign-in window opens in the browser the operator is using.
      browser: validation.data.browser,
    });

    if (!result.success || !result.credentials) {
      return NextResponse.json(
        {
          success: false,
          // Hard Rule #12: the service's own error may still carry a raw
          // browser/Playwright dump — never ship it to the dashboard as-is.
          error: sanitizeErrorMessage(result.error) || "Sign-in did not complete",
        },
        { status: 400 }
      );
    }

    // Build the canonical payload the executors read. The raw extraction map
    // (cookie name → value) is NOT a credential the executors can use:
    // perplexity-web and grok-web read `credentials.apiKey` as a Cookie header
    // and claude-web reads `providerSpecificData.cookie`.
    const payload = buildWebSessionCredentialPayload({
      providerId: provider,
      extracted: result.credentials,
      cookies: result.cookies,
    });

    if (!payload.credential) {
      return NextResponse.json(
        {
          success: false,
          error:
            "The browser session did not yield a usable credential for this provider. Sign in again and retry.",
        },
        { status: 400 }
      );
    }

    // A capture that reused the saved browser profile can hand back a session
    // the provider has since invalidated. Probe it before handing it to the
    // form, and drop the stale profile so the next attempt asks for a real
    // sign-in.
    if (result.alreadySignedIn) {
      const { capturedSessionProbe } = await import("@/lib/providers/webSessionCapture");
      const validation = await capturedSessionProbe.validate(provider, payload);
      if (validation.expired) {
        const { clearBrowserProfile } =
          await import("@omniroute/open-sse/services/inAppLoginService.ts");
        clearBrowserProfile(provider);
        return NextResponse.json(
          {
            success: false,
            error:
              "The saved browser session for this provider has expired. Run the sign-in again to refresh it.",
          },
          { status: 400 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      persisted: false,
      provider,
      credential: payload.credential,
      apiKey: payload.apiKey,
      providerSpecificData: payload.providerSpecificData,
      alreadySignedIn: result.alreadySignedIn === true,
    });
  } catch (err) {
    // Hard Rule #12: never put raw err.message/stack in a response body.
    const msg = sanitizeErrorMessage(err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
