/**
 * Canonical web-session credential payload builder.
 *
 * A web-session provider authenticates from a live browser session: a Cookie
 * header (cookie-kind) or a bearer token held in localStorage / attached to a
 * request header (token-kind). Operators used to paste those values by hand
 * from DevTools; the browser sign-in flow captures them from a real browser
 * instead (see `open-sse/services/inAppLoginService.ts`).
 *
 * The capture path MUST produce the exact shape the executors read, otherwise
 * a successful capture is a silent no-op at request time:
 *
 *   - cookie-kind: `apiKey` carries the full Cookie header (perplexity-web,
 *     grok-web, blackbox-web and copilot-web read `credentials.apiKey`) AND
 *     `providerSpecificData.cookie` carries the same header (claude-web and
 *     notion-web read `providerSpecificData.cookie`). Setting both keeps every
 *     reader working regardless of which convention it expects.
 *   - token-kind: `apiKey` carries the BARE token (zai-web, deepseek-web and
 *     copilot-web read `credentials.apiKey` and add the `Bearer ` prefix
 *     themselves — a JSON blob or an already-prefixed value breaks them),
 *     mirrored into `providerSpecificData` under the provider's storage keys.
 *
 * Pure module — no DB, no network, no browser. Safe to unit-test in isolation.
 */

import { getWebSessionCredentialRequirement } from "@/shared/providers/webSessionCredentials";
import {
  getExtractionConfig,
  type TokenSource,
} from "@omniroute/open-sse/services/tokenExtractionConfig.ts";

export interface WebSessionCookieEntry {
  name: string;
  value: string;
}

export interface WebSessionCredentialPayloadInput {
  /** Provider id, e.g. "claude-web". */
  providerId: string;
  /** Flat map of captured values keyed by cookie name / localStorage key / header name. */
  extracted: Record<string, string>;
  /**
   * Every cookie observed in the browser context for the provider's domain.
   * Preferred over the declared token sources so companion cookies that the
   * provider needs but does not declare (grok's `sso-rw`, Cloudflare's
   * `cf_clearance`) survive the capture.
   */
  cookies?: WebSessionCookieEntry[];
  /** Overrides the provider's declared token sources (tests / custom providers). */
  tokenSources?: readonly TokenSource[];
}

export interface WebSessionCredentialPayload {
  /**
   * The canonical credential string — byte-identical to what the operator
   * would have pasted by hand. This is what the dashboard pre-fills.
   */
  credential: string;
  /** Value for the connection's `apiKey` column (null when nothing was captured). */
  apiKey: string | null;
  /** Session data to merge into the connection's `providerSpecificData`. */
  providerSpecificData: Record<string, unknown>;
}

const EMPTY_PAYLOAD: WebSessionCredentialPayload = {
  credential: "",
  apiKey: null,
  providerSpecificData: {},
};

/** Strip a `Bearer ` prefix from a captured Authorization header value. */
function stripBearerPrefix(value: string): string {
  return value
    .trim()
    .replace(/^bearer\s+/i, "")
    .trim();
}

/**
 * Assemble a Cookie header from a cookie jar.
 *
 * Cookies with an empty value are dropped: an empty pair carries no session
 * material and only adds noise to the header (LMArena's legacy
 * `arena-auth-prod-v1` cookie is empty while the real session lives in the
 * `.0` / `.1` chunks).
 */
export function buildCookieHeader(cookies: readonly WebSessionCookieEntry[]): string {
  const parts: string[] = [];
  for (const cookie of cookies) {
    if (!cookie || typeof cookie.name !== "string") continue;
    const name = cookie.name.trim();
    if (!name) continue;
    const value = typeof cookie.value === "string" ? cookie.value : "";
    if (!value) continue;
    parts.push(`${name}=${value}`);
  }
  return parts.join("; ");
}

/** Resolve the provider's declared token sources, falling back to the shared config. */
function resolveTokenSources(
  providerId: string,
  override?: readonly TokenSource[]
): readonly TokenSource[] {
  if (override) return override;
  return getExtractionConfig(providerId)?.tokenSources ?? [];
}

/**
 * Pick the bearer token for a token-kind provider.
 *
 * Order mirrors the providers' own documented preference: a localStorage /
 * sessionStorage token first, then a captured request header, and only then a
 * cookie (the legacy fallback for providers like Kimi).
 */
function resolveTokenValue(
  sources: readonly TokenSource[],
  extracted: Record<string, string>,
  cookieValues: Map<string, string>
): string {
  for (const source of sources) {
    if (source.type !== "localStorage" && source.type !== "sessionStorage") continue;
    const value = extracted[source.key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  for (const source of sources) {
    if (source.type !== "header") continue;
    const value = extracted[source.name];
    if (typeof value === "string" && value.trim()) return stripBearerPrefix(value);
  }

  for (const source of sources) {
    if (source.type !== "cookie") continue;
    const value = cookieValues.get(source.name);
    if (value) return value;
  }

  return "";
}

/**
 * Build the canonical credential payload for a captured browser session.
 *
 * Returns an empty payload (empty credential, null apiKey, no
 * providerSpecificData) when the provider has no web-session requirement or
 * when the capture produced nothing usable — callers must treat that as a
 * failed capture rather than persisting an empty credential.
 */
export function buildWebSessionCredentialPayload(
  input: WebSessionCredentialPayloadInput
): WebSessionCredentialPayload {
  const requirement = getWebSessionCredentialRequirement(input.providerId);
  if (!requirement || requirement.kind === "none") return { ...EMPTY_PAYLOAD };

  const sources = resolveTokenSources(input.providerId, input.tokenSources);
  const extracted = input.extracted ?? {};

  // ── Cookie jar ───────────────────────────────────────────────────────────
  const cookieEntries: WebSessionCookieEntry[] = [];
  if (input.cookies && input.cookies.length > 0) {
    cookieEntries.push(...input.cookies);
  } else {
    for (const source of sources) {
      if (source.type !== "cookie") continue;
      const value = extracted[source.name];
      if (typeof value === "string" && value) {
        cookieEntries.push({ name: source.name, value });
      }
    }
  }

  const cookieValues = new Map<string, string>();
  for (const entry of cookieEntries) {
    if (!entry || typeof entry.name !== "string") continue;
    const name = entry.name.trim();
    if (!name) continue;
    const value = typeof entry.value === "string" ? entry.value : "";
    if (!value) continue;
    cookieValues.set(name, value);
  }

  // ── cookie-kind ──────────────────────────────────────────────────────────
  if (requirement.kind === "cookie") {
    const header = buildCookieHeader(cookieEntries);
    if (!header) return { ...EMPTY_PAYLOAD };

    const providerSpecificData: Record<string, unknown> = {};
    // Every declared storage key carries the full header, matching the shape
    // the bulk-import path has always written.
    for (const key of requirement.storageKeys) {
      providerSpecificData[key] = header;
    }
    // The real cookie names additionally carry their own value, so a reader
    // that expects a single cookie value (not a header) still works.
    for (const [name, value] of cookieValues) {
      if (!(name in providerSpecificData)) providerSpecificData[name] = value;
    }

    return { credential: header, apiKey: header, providerSpecificData };
  }

  // ── token-kind ───────────────────────────────────────────────────────────
  const token = resolveTokenValue(sources, extracted, cookieValues);
  if (!token) return { ...EMPTY_PAYLOAD };

  const providerSpecificData: Record<string, unknown> = {};
  for (const key of requirement.storageKeys) {
    providerSpecificData[key] = token;
  }
  for (const source of sources) {
    const key = source.type === "cookie" || source.type === "header" ? source.name : source.key;
    if (!(key in providerSpecificData)) providerSpecificData[key] = token;
  }

  return { credential: token, apiKey: token, providerSpecificData };
}
