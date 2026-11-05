/**
 * Server-side helpers for the browser sign-in capture flow.
 *
 * Separate from `webSessionCredentialPayload.ts` (which is a pure module — no
 * DB, no network, no browser) because everything here talks to the upstream
 * provider.
 */

import { validateWebCookieProvider } from "@/lib/providers/validation/webCookie";
import { getWebSessionCredentialRequirement } from "@/shared/providers/webSessionCredentials";
import type { WebSessionCredentialPayload } from "./webSessionCredentialPayload";

export interface CapturedSessionValidation {
  /** True unless the provider definitively rejected the session. */
  valid: boolean;
  /** True only when the provider answered 401/403 — a definitive "signed out". */
  expired: boolean;
}

/** The shape of a provider-validation result that matters for a captured session. */
export interface CapturedSessionProbeResult {
  valid?: boolean;
  error?: string | null;
  errorCode?: string | null;
  unsupported?: boolean;
}

/**
 * Map a provider-validation result onto "is this session dead?".
 *
 * Only a definitive 401/403 counts as expired. A provider that cannot be
 * probed (`unsupported: true`), a network failure, or any other non-auth
 * status is inconclusive and MUST NOT be treated as an expired session —
 * clearing the browser profile on an inconclusive probe would throw away a
 * working sign-in.
 */
export function interpretCapturedSessionProbe(
  result: CapturedSessionProbeResult | null | undefined
): CapturedSessionValidation {
  const expired = result?.error === "SESSION_EXPIRED" || result?.errorCode === "AUTH_007";
  return { valid: !expired, expired };
}

async function probeProvider(
  providerId: string,
  payload: WebSessionCredentialPayload
): Promise<CapturedSessionValidation> {
  if (!isProbeableProvider(providerId)) {
    // The probe sends the credential as a `Cookie:` header. For a token
    // provider that would put a bare token in a cookie header, get a 401 and
    // be reported as an expired session — so the capture is left alone.
    return { valid: true, expired: false };
  }
  try {
    const result = await validateWebCookieProvider({
      provider: providerId,
      apiKey: payload.apiKey ?? undefined,
      providerSpecificData: payload.providerSpecificData,
    });
    return interpretCapturedSessionProbe(result);
  } catch {
    // Inconclusive probe — never invalidate the captured session on it.
    return { valid: true, expired: false };
  }
}

/**
 * Whether the shared web-cookie probe can judge this provider's credential.
 *
 * The probe sends the credential as a `Cookie:` header, so it is only
 * meaningful for providers whose session IS a cookie. `zai-web` is the one
 * token provider the probe special-cases (it sends `Authorization: Bearer`
 * instead), so it is included explicitly.
 */
export function isProbeableProvider(providerId: string): boolean {
  if (providerId === "zai-web") return true;
  return getWebSessionCredentialRequirement(providerId)?.kind === "cookie";
}

/**
 * The probe used to check a re-synced session.
 *
 * Exposed as an object with a swappable method so tests can replace the
 * implementation without reaching for the network — the same shape as the
 * `inAppLoginService` singleton the route already monkey-patches.
 */
export const capturedSessionProbe = {
  validate: probeProvider,
};
