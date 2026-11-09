/**
 * Browser family detection.
 *
 * The dashboard knows which browser the operator is looking at right now —
 * that is a better signal than the OmniRoute host's default browser, because
 * the operator is about to sign in and wants to do it where they already are.
 *
 * This module is imported by both the client (the dashboard component) and
 * the server (the launch planner), so it must stay free of Node built-ins.
 */

/** The browser families the sign-in window can be opened in. */
export type BrowserFamily = "firefox" | "chrome" | "edge" | "safari" | "unknown";

/** Every value accepted by the request schema, in a stable order. */
export const BROWSER_FAMILIES = ["firefox", "chrome", "edge", "safari", "unknown"] as const;

/**
 * The browser family a user agent string belongs to.
 *
 * Order matters: Edge and Chrome both advertise "Safari", and Chrome
 * advertises "Safari" too, so the more specific tokens are checked first.
 */
export function detectBrowserFamily(userAgent: string): BrowserFamily {
  const ua = (userAgent || "").toLowerCase();
  if (!ua) return "unknown";
  if (ua.includes("firefox") || ua.includes("fxios")) return "firefox";
  if (ua.includes("edg/") || ua.includes("edgios") || ua.includes("edga/")) return "edge";
  if (ua.includes("chrome/") || ua.includes("chromium/") || ua.includes("crios")) return "chrome";
  if (ua.includes("safari/") || ua.includes("iphone") || ua.includes("ipad")) return "safari";
  return "unknown";
}

/**
 * Coerce an untrusted value into a browser family.
 *
 * Used by the routes that parse their body without a schema: an unknown or
 * malformed value means "no preference", never a crash.
 */
export function normalizeBrowserFamily(value: unknown): BrowserFamily {
  if (typeof value !== "string") return "unknown";
  return (BROWSER_FAMILIES as readonly string[]).includes(value)
    ? (value as BrowserFamily)
    : "unknown";
}
