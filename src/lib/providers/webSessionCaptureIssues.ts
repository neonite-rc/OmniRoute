/**
 * Bridges the browser-capture outcome to the web-session issue tracker.
 *
 * The capture layer knows what happened (a captcha stood in the way, the
 * saved session was rejected, the sign-in worked); the issue tracker knows
 * when that deserves a prompt. This module is the seam between them.
 *
 * Recording an issue must never break a capture: the operator's session is
 * more important than the prompt, so a tracker failure is logged and the
 * capture continues.
 */

import { recordWebSessionIssue, resolveWebSessionIssues } from "./webSessionIssues";

function safeRecord(
  providerId: string,
  kind: "session_expired" | "captcha_blocked",
  detail?: string | null
): void {
  try {
    recordWebSessionIssue({ providerId, kind, detail: detail ?? null });
  } catch (error) {
    console.error("Failed to record web-session issue:", error);
  }
}

/**
 * A captcha / anti-bot challenge kept the sign-in from completing.
 *
 * The issue tracker decides whether this is the first blip (silent) or a
 * problem that persists (prompt).
 */
export function noteCaptchaBlocked(providerId: string, detail?: string | null): void {
  safeRecord(providerId, "captcha_blocked", detail);
}

/**
 * The provider rejected the saved session — it expired.
 */
export function noteSessionExpired(providerId: string, detail?: string | null): void {
  safeRecord(providerId, "session_expired", detail);
}

/**
 * The sign-in worked — every open issue for this provider is solved.
 *
 * A solved problem must not prompt again; a problem that comes back later
 * opens a new episode.
 */
export function noteSessionHealthy(providerId: string): void {
  try {
    resolveWebSessionIssues(providerId);
  } catch (error) {
    console.error("Failed to resolve web-session issues:", error);
  }
}
