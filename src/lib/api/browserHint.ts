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
 * The signal is the authz pipeline's trusted locality verdict
 * (`AUTHZ_HEADER_PEER_LOCALITY`) and the trusted peer IP it forwards
 * (`AUTHZ_HEADER_TRUSTED_PEER_IP`). Both are stripped from client input and
 * re-set by the pipeline from the real TCP peer, so a client cannot forge
 * them. The Host header is only a fallback for callers that carry no trusted
 * header at all (direct Node calls, tests).
 *
 * This only steers which browser opens. It never decides an auth or security
 * outcome. The same reasoning is applied by `buildRemoteOAuthHint` for the
 * OAuth callback.
 */

import os from "node:os";

import {
  AUTHZ_HEADER_PEER_LOCALITY,
  AUTHZ_HEADER_TRUSTED_PEER_IP,
} from "@/server/authz/headers";
import { isLoopbackHost } from "@/server/authz/routeGuard";
import type { BrowserFamily } from "@/shared/providers/browserFamily";

/**
 * Is this address one of this host's own?
 *
 * A browser on this machine that reaches OmniRoute through the machine's LAN
 * address connects from that same address — so the peer is one of the host's
 * own interfaces rather than a loopback one. Both mean "same machine".
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

  // 1. The trusted locality verdict from the authz pipeline.
  const locality = request.headers.get(AUTHZ_HEADER_PEER_LOCALITY);
  if (locality) {
    if (locality === "loopback") return requested;
    // A same-machine request that went through the machine's own LAN address
    // arrives from that address — the trusted peer IP tells it apart from a
    // real remote machine on the same network.
    const trustedPeerIp = request.headers.get(AUTHZ_HEADER_TRUSTED_PEER_IP);
    if (trustedPeerIp && isHostOwnAddress(trustedPeerIp)) return requested;
    return "unknown";
  }

  // 2. No trusted verdict (direct Node call, tests): fall back to the Host
  //    header. Spoofable — a UI hint only, never a security decision.
  const hostHeader = request.headers.get("host");
  if (hostHeader == null) return requested;
  return isLoopbackHost(hostHeader) ? requested : "unknown";
}
