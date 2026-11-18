import { WEB_COOKIE_PROVIDERS } from "@/shared/constants/providers";
import { validateWebCookieProvider } from "@/lib/providers/validation/webCookie";
import { updateProviderConnection } from "@/lib/db/providers";
import { recordWebSessionIssue } from "@/lib/providers/webSessionIssues";

/**
 * Verify-only background probe for web-cookie connections (#11488).
 *
 * The token health-check sweep historically iterated ONLY `auth_type = 'oauth'`
 * rows, and even for those a missing refresh-token short-circuits into a no-op.
 * Web-cookie connections (`auth_type = 'cookie'`) therefore kept
 * `testStatus = "active"` forever — a dead cookie surfaced only when a live
 * user request failed with 401/403.
 *
 * This leaf mirrors `tokenHealthCheckKimi.ts` / `tokenHealthCheckCursor.ts`:
 * pure decision + persistence, with every side-effecting function injectable
 * so tests can drive outcomes without network or DB.
 *
 * Probe semantics reuse `validateWebCookieProvider` — the same generic
 * session-ping the dashboard Test button falls back to — because its result
 * contract is deterministic: 401/403 → `{ error: "SESSION_EXPIRED",
 * errorCode: "AUTH_007" }`, registry-less providers → `unsupported: true`.
 * The richer per-provider specialty validators are deliberately NOT used here:
 * a background sweep that can terminal-state a connection must only act on an
 * unambiguous signal, and must treat every ambiguous failure (network blip,
 * SSRF-guard block, 5xx) as "unknown" — stamp the tick, change nothing.
 */

/** Minimal structural view of a connection row this prober reads. */
export interface WebCookieProbeConnection {
  id: string;
  provider?: string | null;
  apiKey?: string | null;
  providerSpecificData?: unknown;
  lastHealthCheckAt?: string | null;
}

type LogFn = (...msg: unknown[]) => void;

/** True when `provider` is a catalogued web-cookie provider this module can probe. */
export function isWebCookieHealthProbeCandidate(provider: unknown): boolean {
  const key = String(provider || "").toLowerCase();
  return Boolean((WEB_COOKIE_PROVIDERS as Record<string, unknown>)[key]);
}

function readCredential(conn: WebCookieProbeConnection): string {
  const direct = typeof conn.apiKey === "string" ? conn.apiKey.trim() : "";
  if (direct) return direct;
  const psd = conn.providerSpecificData;
  if (psd && typeof psd === "object" && !Array.isArray(psd)) {
    const cookie = (psd as Record<string, unknown>).cookie;
    return typeof cookie === "string" ? cookie.trim() : "";
  }
  return "";
}

/**
 * Whether the probe was refused by a bot challenge.
 *
 * The flag is only set by the generic web-cookie probe, so it is read
 * structurally — the probe's result type is a union of every validator's
 * shape and only one of them carries the flag.
 */
function isChallengeBlocked(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  return (result as { challengeBlocked?: unknown }).challengeBlocked === true;
}

function isSessionExpiredResult(result: {
  valid: boolean;
  error?: string | null;
  errorCode?: string | null;
  challengeBlocked?: boolean;
}): boolean {
  // A bot challenge is NOT an expiry. The upstream answered 403 with a
  // challenge page, so the cookie behind it may still be valid — marking the
  // connection expired here would kill a working session over a challenge the
  // operator can solve.
  if (result.challengeBlocked) return false;
  return (
    result.valid === false &&
    (result.errorCode === "AUTH_007" ||
      String(result.error || "")
        .toUpperCase()
        .includes("SESSION_EXPIRED"))
  );
}

export async function checkWebCookieConnectionIfNeeded(params: {
  conn: WebCookieProbeConnection;
  now: string;
  /** Sweep-computed interval in minutes; 0 already filtered by the caller. */
  intervalMin: number;
  log: LogFn;
  logWarn: LogFn;
  getConnectionLogLabel: (conn: {
    name?: string | null;
    email?: string | null;
    id?: string | null;
  }) => string;
  logPrefix: string;
  probeFn?: typeof validateWebCookieProvider;
  persistFn?: typeof updateProviderConnection;
}): Promise<boolean> {
  const { conn, now, intervalMin, logWarn, getConnectionLogLabel, logPrefix } = params;
  if (!isWebCookieHealthProbeCandidate(conn?.provider)) return false;

  // Interval gate FIRST so steady-state ticks cost one date comparison, not a probe.
  const lastCheckMs = conn.lastHealthCheckAt ? new Date(conn.lastHealthCheckAt).getTime() : 0;
  if (lastCheckMs > 0 && new Date(now).getTime() - lastCheckMs < intervalMin * 60 * 1000)
    return true;

  const persist = params.persistFn || updateProviderConnection;
  const probe = params.probeFn || validateWebCookieProvider;
  const label = `${String(conn.provider)}/${getConnectionLogLabel(conn)}`;

  const credential = readCredential(conn);
  if (!credential) {
    await persist(conn.id, { lastHealthCheckAt: now });
    return true;
  }

  const result = await probe({ provider: String(conn.provider), apiKey: credential });

  if (result.valid) {
    // Steady state: silent stamp only (per-tick chatter would emit ~1440 lines/day).
    await persist(conn.id, { lastHealthCheckAt: now });
    return true;
  }

  if (result.unsupported) {
    // No honest probe exists for this provider (registry-less / no /models API):
    // keep the row untouched except for the cadence stamp.
    await persist(conn.id, { lastHealthCheckAt: now });
    return true;
  }

  if (isChallengeBlocked(result)) {
    // The upstream put a captcha / anti-bot challenge in front of the probe.
    // The session may still be alive, so the connection keeps its state — but
    // the problem is recorded, so the dashboard can prompt when the challenge
    // keeps coming back.
    logWarn(
      `${logPrefix} ${label} blocked by an anti-bot challenge; keeping the session and retrying next interval`
    );
    try {
      recordWebSessionIssue({
        providerId: String(conn.provider),
        kind: "captcha_blocked",
        detail: "The upstream refused the session probe with a bot challenge.",
      });
    } catch (error) {
      logWarn(`${logPrefix} could not record the challenge for ${label}: ${error}`);
    }
    await persist(conn.id, { lastHealthCheckAt: now });
    return true;
  }

  if (isSessionExpiredResult(result)) {
    logWarn(
      `${logPrefix} ${label} cookie rejected by upstream (401/403); marking expired — re-paste the cookie to reactivate`
    );
    await persist(conn.id, {
      testStatus: "expired",
      lastHealthCheckAt: now,
      lastError: "Session cookie expired or was revoked by the upstream site.",
      lastErrorAt: now,
      lastErrorType: "session_expired",
      lastErrorSource: "webcookie",
      errorCode: "session_expired",
    });
    return true;
  }

  // Ambiguous failure (network error, guard block, unexpected status): never flip
  // state on it — a transient blip must not terminal-state a healthy cookie.
  logWarn(`${logPrefix} ${label} probe inconclusive (${result.error}); will retry next interval`);
  await persist(conn.id, { lastHealthCheckAt: now });
  return true;
}
