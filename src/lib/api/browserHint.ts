/**
 * Which browser the sign-in window should open in.
 *
 * The dashboard reports the browser family it is running in (Firefox, Chrome,
 * Edge, Safari). That is only meaningful when the dashboard is open on the
 * OmniRoute host itself: then the operator's browser and the OmniRoute host
 * are the same machine, and the sign-in can happen in the very browser they
 * are looking at.
 *
 * When the dashboard is served to another machine — a laptop driving a
 * VPS-hosted OmniRoute, a tunnel — the operator's browser lives over there
 * and says nothing about what the host can open. The host's own default
 * browser is used instead.
 *
 * The Host header is spoofable, so this only steers which browser opens. It
 * never decides an auth or security outcome. The same reasoning is applied
 * by `buildRemoteOAuthHint` for the OAuth callback.
 */

import { isLoopbackHost } from "@/server/authz/routeGuard";
import type { BrowserFamily } from "@/shared/providers/browserFamily";

/**
 * The browser family to honour for a sign-in request.
 *
 * Returns `"unknown"` — meaning "no preference, use the host's default" —
 * when the request did not come from a browser on the OmniRoute host.
 */
export function resolveBrowserHintForRequest(
  request: Request,
  requested: BrowserFamily
): BrowserFamily {
  if (!requested || requested === "unknown") return "unknown";

  const hostHeader = request.headers.get("host");
  // No Host header at all (an in-process call): treat it as local.
  if (hostHeader == null) return requested;
  if (!isLoopbackHost(hostHeader)) return "unknown";
  return requested;
}
