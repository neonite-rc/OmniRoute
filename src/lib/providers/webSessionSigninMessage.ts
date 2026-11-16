/**
 * The hand-off between the sign-in tab and the dashboard tab.
 *
 * The dashboard opens the sign-in page in a NEW TAB of the very browser the
 * dashboard is running in (see
 * `src/app/(dashboard)/dashboard/providers/web-session-signin/page.tsx`). That
 * tab runs the sign-in — either a window on the OmniRoute host or the streamed
 * view — and hands the captured session back to the dashboard tab through this
 * message.
 *
 * Same-origin only: the sender posts to `window.location.origin` and the
 * receiver checks `event.origin` before reading the payload.
 */

export const WEB_SESSION_SIGNIN_MESSAGE = "omniroute-web-session-signin" as const;

export interface WebSessionSigninResult {
  /** Discriminator — other messages on the page are ignored. */
  type: typeof WEB_SESSION_SIGNIN_MESSAGE;
  /** True when a session was captured. */
  success: boolean;
  /** The canonical credential string (Cookie header or bare token). */
  credential?: string;
  /** Structured session data to store alongside the credential. */
  providerSpecificData?: Record<string, unknown>;
  /** True when the session was reused from the saved browser profile. */
  alreadySignedIn?: boolean;
  /** Why the sign-in failed. */
  error?: string;
}

/** Is this message the sign-in hand-off? */
export function isWebSessionSigninResult(value: unknown): value is WebSessionSigninResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WebSessionSigninResult>;
  return candidate.type === WEB_SESSION_SIGNIN_MESSAGE && typeof candidate.success === "boolean";
}
