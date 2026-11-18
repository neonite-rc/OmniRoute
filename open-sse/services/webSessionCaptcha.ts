/**
 * Captcha / bot-challenge detection for the browser sign-in flow.
 *
 * The browser login polls a provider's login page until the session cookie (or
 * the provider's token) shows up. When a captcha or an anti-bot interstitial
 * sits in front of the login, the poll simply times out and the operator gets
 * "Login timed out" — no clue that the real problem was a challenge they could
 * have solved in the sign-in window.
 *
 * This module classifies the signals a page offers (title, URL, visible text)
 * into "a challenge is in the way" or "no challenge". It is deliberately
 * conservative: only markers that a normal login page never shows count, so a
 * login page that merely embeds a captcha widget is NOT reported as blocked.
 *
 * The same classifier is used for the HTTP probe (a 403 whose body is a
 * Cloudflare/Turnstile interstitial is a challenge, not an expired session) —
 * that distinction decides whether the saved browser profile is kept.
 */

/** The page signals the classifier looks at. */
export interface CaptchaSignals {
  /** `document.title` of the page. */
  title?: string | null;
  /** The page URL. */
  url?: string | null;
  /** A bounded slice of the visible page text. */
  bodyText?: string | null;
}

export interface CaptchaMatch {
  /** Stable id of the matched marker (used for logs and tests). */
  id: string;
  /** Human label for the challenge kind. */
  label: string;
}

interface CaptchaMarker {
  id: string;
  label: string;
  pattern: RegExp;
}

/**
 * Markers that identify a challenge INTERSTITIAL — a page that exists only to
 * ask for a human check. A normal login page never contains these.
 */
const TITLE_MARKERS: CaptchaMarker[] = [
  { id: "cloudflare-just-a-moment", label: "Cloudflare", pattern: /\bjust a moment\b/i },
  { id: "cloudflare-attention-required", label: "Cloudflare", pattern: /attention required/i },
  { id: "browser-check", label: "a browser check", pattern: /checking your browser/i },
  { id: "human-verification", label: "a human-verification check", pattern: /verify (?:that )?you(?:'re| are) (?:a )?human/i },
  { id: "unusual-traffic", label: "a traffic check", pattern: /unusual traffic/i },
  { id: "security-check", label: "a security check", pattern: /\bsecurity check\b/i },
];

/**
 * URL markers. A challenge URL is unambiguous — a login page never lives
 * under `/cdn-cgi/challenge-platform/` or Google's `/sorry/` interstitial.
 */
const URL_MARKERS: CaptchaMarker[] = [
  { id: "cloudflare-challenge-url", label: "Cloudflare", pattern: /cdn-cgi\/challenge-platform/i },
  { id: "cloudflare-challenge-host", label: "Cloudflare", pattern: /challenges\.cloudflare\.com/i },
  { id: "google-sorry-url", label: "a traffic check", pattern: /\/sorry\//i },
  { id: "challenge-url", label: "a challenge page", pattern: /[?&]challenge=/i },
];

/**
 * Body markers. Only interstitial phrases — the bare names of captcha widgets
 * ("recaptcha", "turnstile") are deliberately absent, because a login page
 * that embeds a captcha widget is still a normal login page.
 */
const BODY_MARKERS: CaptchaMarker[] = [
  { id: "cloudflare-just-a-moment", label: "Cloudflare", pattern: /\bjust a moment\b/i },
  { id: "cloudflare-attention-required", label: "Cloudflare", pattern: /attention required/i },
  { id: "cloudflare-challenge-var", label: "Cloudflare", pattern: /\b_cf_chl_opt\b|\bcf-chl-/i },
  { id: "cloudflare-turnstile", label: "Turnstile", pattern: /\bcf-turnstile\b/i },
  { id: "browser-check", label: "a browser check", pattern: /checking your browser/i },
  { id: "human-verification", label: "a human-verification check", pattern: /verify (?:that )?you(?:'re| are) (?:a )?human/i },
  { id: "unusual-traffic", label: "a traffic check", pattern: /unusual traffic/i },
  {
    id: "browser-cookies-required",
    label: "a browser check",
    pattern: /enable javascript and cookies to continue/i,
  },
];

/** How much visible text is inspected. Enough for an interstitial, bounded. */
const BODY_TEXT_LIMIT = 4000;

function firstMatch(text: string | null | undefined, markers: CaptchaMarker[]): CaptchaMatch | null {
  if (!text) return null;
  for (const marker of markers) {
    if (marker.pattern.test(text)) return { id: marker.id, label: marker.label };
  }
  return null;
}

/**
 * Classify the page signals into "a challenge is in the way".
 *
 * Returns the first matching marker, or null when nothing looks like a
 * challenge. The title is checked first (it is the most specific signal),
 * then the URL, then the visible text.
 */
export function detectCaptchaChallenge(signals: CaptchaSignals): CaptchaMatch | null {
  return (
    firstMatch(signals.title, TITLE_MARKERS) ??
    firstMatch(signals.url, URL_MARKERS) ??
    firstMatch(signals.bodyText?.slice(0, BODY_TEXT_LIMIT), BODY_MARKERS)
  );
}

/**
 * Whether a challenge marker appears anywhere in a response body.
 *
 * Used by the HTTP session probe: a 403 that carries a Cloudflare/Turnstile
 * interstitial is a challenge (the session may still be alive), while a 403
 * with a normal auth error is a genuinely expired session.
 */
export function detectCaptchaInBody(bodyText: string | null | undefined): CaptchaMatch | null {
  return firstMatch(bodyText?.slice(0, BODY_TEXT_LIMIT), BODY_MARKERS);
}

/** The minimal page surface the detector needs — keeps Playwright out of it. */
interface CaptchaPageProbe {
  title?: () => Promise<string>;
  url?: () => string;
  evaluate?: (pageFunction: (arg: string) => unknown, arg: string) => Promise<unknown>;
}

/**
 * Inspect a live page for a challenge.
 *
 * Never throws: a page that cannot be inspected is "no challenge detected".
 */
export async function detectCaptchaOnPage(page: unknown): Promise<CaptchaMatch | null> {
  const probe = page as CaptchaPageProbe;

  let title: string | null = null;
  try {
    title = probe.title ? await probe.title() : null;
  } catch {
    title = null;
  }

  let url: string | null = null;
  try {
    url = probe.url ? probe.url() : null;
  } catch {
    url = null;
  }

  const titleMatch = firstMatch(title, TITLE_MARKERS);
  const urlMatch = firstMatch(url, URL_MARKERS);
  if (titleMatch || urlMatch) return titleMatch ?? urlMatch;

  let bodyText: string | null = null;
  try {
    if (probe.evaluate) {
      const text = await probe.evaluate(
        (limit: string) => {
          const body = (globalThis as { document?: { body?: { innerText?: string } } }).document?.body;
          const inner = body?.innerText ?? "";
          return inner.slice(0, Number(limit) || 0);
        },
        String(BODY_TEXT_LIMIT)
      );
      bodyText = typeof text === "string" ? text : null;
    }
  } catch {
    bodyText = null;
  }

  return firstMatch(bodyText, BODY_MARKERS);
}

/**
 * The operator-facing message for a blocked sign-in.
 *
 * The challenge is solved in the sign-in window, not by OmniRoute — the
 * message says where to look.
 */
export function describeCaptchaBlock(match: CaptchaMatch | null): string {
  const kind = match?.label ?? "a captcha";
  return (
    `A ${kind} challenge is blocking the sign-in. Solve it in the sign-in window ` +
    `(the browser window opened by OmniRoute, or the sign-in view inside the dashboard) ` +
    `and the sign-in continues on its own.`
  );
}
