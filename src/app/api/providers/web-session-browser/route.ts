/**
 * GET /api/providers/web-session-browser
 *
 * Reports which browser the "Sign in with browser" window will use.
 *
 * The sign-in opens the host's DEFAULT browser rather than always Playwright's
 * bundled Chromium, so the operator signs in where they already are: their own
 * Firefox, their own Chrome, their own Edge. When the host's default browser
 * is already running with a remote-debugging endpoint, OmniRoute attaches to
 * that very browser — the operator's accounts are already signed in, so the
 * capture needs no password at all.
 *
 * The dashboard calls this to tell the operator which window to watch. It
 * launches nothing and spawns no process, so it is not LOCAL_ONLY.
 */

import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { BROWSER_FAMILIES, type BrowserFamily } from "@/shared/providers/browserFamily";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  // The dashboard passes the browser family it detected in its own user agent
  // so the answer matches the window the operator is actually looking at.
  const requested = new URL(request.url).searchParams.get("browser");
  const family: BrowserFamily =
    requested && (BROWSER_FAMILIES as readonly string[]).includes(requested)
      ? (requested as BrowserFamily)
      : "unknown";

  try {
    const { describeBrowserLaunch } =
      await import("@omniroute/open-sse/services/inAppLoginService.ts");
    const info = await describeBrowserLaunch(family);
    return NextResponse.json({
      browserName: info.browserName,
      usesRunningBrowser: info.usesRunningBrowser,
      mode: info.mode,
      requestedBrowser: family === "unknown" ? null : family,
    });
  } catch {
    // Detection is best-effort: the dashboard must still be able to offer the
    // sign-in even when the host's browser layout cannot be inspected.
    return NextResponse.json({
      browserName: family === "firefox" ? "Firefox" : "Chromium",
      usesRunningBrowser: false,
      mode: "bundled",
      requestedBrowser: family === "unknown" ? null : family,
    });
  }
}
