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
 * The signal used is the token-stamped socket peer our own server writes
 * (`PEER_IP_HEADER`), which cannot be forged by a client. The Host header is
 * only a fallback for callers that carry no stamp (direct Node calls, tests).
 *
 * This only steers which browser opens. It never decides an auth or security
 * outcome. The same reasoning is applied by `buildRemoteOAuthHint` for the
 * OAuth callback.
 */

import os from "node:os";

import { PEER_IP_HEADER, VIA_PROXY_HEADER } from "@/server/authz/headers";
import { resolveStampedPeer, resolveStampedViaProxy } from "@/server/authz/peerStamp";
import { classifyHostLocality, isLoopbackHost } from "@/server/authz/routeGuard";
import type { BrowserFamily } from "@/shared/providers/browserFamily";

/**
 * Is this address one of this host's own?
 *
 * A browser on this machine that reaches OmniRoute through the machine's LAN
 * address connects from that same address — so the peer is one of the host's
 * own interfaces, not a loopback one. Both mean "same machine".
 */
function isHostOwnAddress(ip: string): boolean {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.address === ip) return true;
    }
  }
  return false;
}

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

  // 1. The trusted socket peer, stamped by our own server. This works no
  //    matter which address the dashboard was opened with.
  const stampToken = process.env.OMNIROUTE_PEER_STAMP_TOKEN;
  const peer = resolveStampedPeer(request.headers.get(PEER_IP_HEADER), stampToken);
  if (peer) {
    // Behind a reverse proxy the socket peer is the proxy hop, not the
    // operator's browser — the hint says nothing about this host.
    if (resolveStampedViaProxy(request.headers.get(VIA_PROXY_HEADER), stampToken)) {
      return "unknown";
    }
    if (classifyHostLocality(peer) === "loopback" || isHostOwnAddress(peer)) {
      return requested;
    }
    return "unknown";
  }

  // 2. No stamp: fall back to the Host header (spoofable — a UI hint only).
  const hostHeader = request.headers.get("host");
  if (hostHeader == null) return requested;
  return isLoopbackHost(hostHeader) ? requested : "unknown";
}
