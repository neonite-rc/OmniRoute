import test from "node:test";
import assert from "node:assert/strict";

const {
  captureConfiguredHeaders,
  filterProviderCookies,
  isPersistentProfileEnabled,
  resolveBrowserProfileDir,
  resolveProviderCookieDomain,
} = await import("../../open-sse/services/inAppLoginService.ts");
const { getExtractionConfig } = await import("../../open-sse/services/tokenExtractionConfig.ts");

test("captureConfiguredHeaders records configured headers case-insensitively", () => {
  const credentials: Record<string, string> = {};

  captureConfiguredHeaders(
    [{ type: "header", name: "Authorization" }],
    { authorization: "Bearer access-token", accept: "application/json" },
    credentials
  );

  assert.deepEqual(credentials, { Authorization: "Bearer access-token" });
});

test("captureConfiguredHeaders ignores cookies and does not replace a captured token", () => {
  const credentials = { Authorization: "Bearer first-token" };

  captureConfiguredHeaders(
    [
      { type: "cookie", name: "session", domain: ".example.com" },
      { type: "header", name: "Authorization" },
    ],
    { authorization: "Bearer replacement-token", cookie: "session=value" },
    credentials
  );

  assert.deepEqual(credentials, { Authorization: "Bearer first-token" });
});

// ─── Cookie-domain scoping ──────────────────────────────────────────────────

test("filterProviderCookies keeps cookies from the provider domain only", () => {
  const kept = filterProviderCookies(
    [
      { name: "sessionKey", value: "abc", domain: ".claude.ai" },
      { name: "tracking", value: "nope", domain: ".tracker.tld" },
      { name: "other", value: "nope", domain: "example.com" },
    ],
    "claude.ai"
  );

  assert.deepEqual(kept, [{ name: "sessionKey", value: "abc" }]);
});

test("filterProviderCookies rejects look-alike domains", () => {
  // `claude.ai.attacker.tld` ends with the expected string but is a different
  // host — a substring match would harvest it as the operator's credential.
  const kept = filterProviderCookies(
    [{ name: "sessionKey", value: "evil", domain: "claude.ai.attacker.tld" }],
    "claude.ai"
  );

  assert.deepEqual(kept, []);
});

test("filterProviderCookies accepts subdomains of the provider domain", () => {
  const kept = filterProviderCookies(
    [{ name: "sid", value: "abc", domain: "accounts.google.com" }],
    "google.com"
  );

  assert.deepEqual(kept, [{ name: "sid", value: "abc" }]);
});

test("filterProviderCookies deduplicates repeated cookie names", () => {
  const kept = filterProviderCookies(
    [
      { name: "sid", value: "first", domain: ".example.com" },
      { name: "sid", value: "second", domain: ".example.com" },
    ],
    "example.com"
  );

  assert.deepEqual(kept, [{ name: "sid", value: "first" }]);
});

test("filterProviderCookies returns nothing without a cookie domain", () => {
  const kept = filterProviderCookies([{ name: "sid", value: "abc", domain: ".example.com" }], "");
  assert.deepEqual(kept, []);
});

// ─── Provider cookie domain ─────────────────────────────────────────────────

test("resolveProviderCookieDomain prefers the provider override", () => {
  const config = getExtractionConfig("gemini-web");
  assert.ok(config);
  // Gemini's session spans google.com, not gemini.google.com.
  assert.equal(resolveProviderCookieDomain(config), ".google.com");
});

test("resolveProviderCookieDomain falls back to the home URL hostname", () => {
  const config = getExtractionConfig("claude-web");
  assert.ok(config);
  assert.equal(resolveProviderCookieDomain(config), "claude.ai");
});

// ─── Persistent browser profile ─────────────────────────────────────────────

test("resolveBrowserProfileDir scopes the profile to the provider", () => {
  assert.equal(
    resolveBrowserProfileDir("claude-web", "/data"),
    "/data/browser-profiles/claude-web"
  );
});

test("resolveBrowserProfileDir sanitizes the provider id", () => {
  // A provider id is operator-supplied in places; it must never escape the
  // profile directory.
  const dir = resolveBrowserProfileDir("../../etc/passwd", "/data");
  assert.ok(dir.startsWith("/data/browser-profiles/"));
  assert.ok(!dir.includes(".."));
});

test("isPersistentProfileEnabled follows the opt-out flag", () => {
  const original = process.env.OMNIROUTE_WEB_SESSION_PROFILE;
  try {
    delete process.env.OMNIROUTE_WEB_SESSION_PROFILE;
    assert.equal(isPersistentProfileEnabled(), true);

    process.env.OMNIROUTE_WEB_SESSION_PROFILE = "off";
    assert.equal(isPersistentProfileEnabled(), false);

    process.env.OMNIROUTE_WEB_SESSION_PROFILE = "false";
    assert.equal(isPersistentProfileEnabled(), false);

    process.env.OMNIROUTE_WEB_SESSION_PROFILE = "on";
    assert.equal(isPersistentProfileEnabled(), true);
  } finally {
    if (original === undefined) delete process.env.OMNIROUTE_WEB_SESSION_PROFILE;
    else process.env.OMNIROUTE_WEB_SESSION_PROFILE = original;
  }
});
