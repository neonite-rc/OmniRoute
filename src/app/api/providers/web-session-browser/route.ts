/**
 * GET /api/providers/web-session-browser
 *
 * Reports which browser the "Sign in with browser" window will use, and
 * WHERE that window appears.
 *
 * The sign-in opens in the SAME browser the dashboard is running in, so the
 * operator signs in where they already are: their own Firefox, their own
 * Chrome, their own Edge. When that browser is already running with a
 * remote-debugging endpoint, OmniRoute attaches to that very browser — the
 * operator's accounts are already signed in, so the capture needs no password
 * at all, and the sign-in tab opens in the window they are already using.
 *
 * `mode` says where the operator will see the sign-in:
 *
 *  - `native` — the dashboard is open on the OmniRoute host, so a browser
 *    window opens right there, in front of them.
 *  - `streamed` — the dashboard is open on another machine (or this host has
 *    no display), so the host runs the browser without a display and streams
 *    the view into the dashboard. The operator signs in inside the dashboard,
 *    on their own screen.
 *
 * The browser build is an OmniRoute-side dependency: when it is not cached on
 * the host yet, the host downloads it on the first sign-in. `browserBuildReady`
 * says whether that download is still pending, so the dashboard can say so
 * instead of expecting the operator to install anything.
 *
 * The dashboard calls this to tell the operator which window to watch. It
 * launches nothing and spawns no process, so it is not LOCAL_ONLY.
 */

import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { resolveBrowserHintForRequest, resolveDashboardLocality } from "@/lib/api/browserHint";
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

  // A dashboard served to another machine says nothing about what this host
  // can open, so the host's own default browser is used there.
  const effectiveFamily = resolveBrowserHintForRequest(request, family);

  // Where the sign-in window has to appear. A window opened on the host only
  // reaches the operator when their dashboard runs on this same machine.
  const dashboardOnHost = resolveDashboardLocality(request) === "host";

  try {
    const { describeBrowserLaunch, hostHasDisplay } =
      await import("@omniroute/open-sse/services/inAppLoginService.ts");
    const info = await describeBrowserLaunch(effectiveFamily);
    const displayAvailable = hostHasDisplay();
    return NextResponse.json({
      browserName: info.browserName,
      usesRunningBrowser: info.usesRunningBrowser,
      mode: info.mode,
      browserBuildReady: info.browserBuildReady,
      requestedBrowser: effectiveFamily === "unknown" ? null : effectiveFamily,
      dashboardOnHost,
      displayAvailable,
      signInMode: dashboardOnHost && displayAvailable ? "native" : "streamed",
    });
  } catch {
    // Detection is best-effort: the dashboard must still be able to offer the
    // sign-in even when the host's browser layout cannot be inspected.
    return NextResponse.json({
      browserName: effectiveFamily === "firefox" ? "Firefox" : "Chromium",
      usesRunningBrowser: false,
      mode: "bundled",
      browserBuildReady: true,
      requestedBrowser: effectiveFamily === "unknown" ? null : effectiveFamily,
      dashboardOnHost,
      displayAvailable: false,
      signInMode: "streamed",
    });
  }
}
