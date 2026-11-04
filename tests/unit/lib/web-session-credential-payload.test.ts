import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCookieHeader,
  buildWebSessionCredentialPayload,
} from "../../../src/lib/providers/webSessionCredentialPayload.ts";
import {
  interpretCapturedSessionProbe,
  isProbeableProvider,
} from "../../../src/lib/providers/webSessionCapture.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function payload(
  providerId: string,
  extracted: Record<string, string>,
  cookies?: Array<{ name: string; value: string }>
) {
  return buildWebSessionCredentialPayload({ providerId, extracted, cookies });
}

// ─── Cookie header ──────────────────────────────────────────────────────────

test("buildCookieHeader joins name=value pairs with '; '", () => {
  assert.equal(
    buildCookieHeader([
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ]),
    "a=1; b=2"
  );
});

test("buildCookieHeader drops empty values and nameless entries", () => {
  // LMArena's legacy `arena-auth-prod-v1` cookie is empty; the real session
  // lives in the `.0` / `.1` chunks. Shipping an empty pair adds noise and the
  // provider hint explicitly tells operators not to paste it.
  assert.equal(
    buildCookieHeader([
      { name: "arena-auth-prod-v1", value: "" },
      { name: "arena-auth-prod-v1.0", value: "chunk0" },
      { name: "", value: "orphan" },
    ]),
    "arena-auth-prod-v1.0=chunk0"
  );
});

test("buildCookieHeader returns an empty string for an empty jar", () => {
  assert.equal(buildCookieHeader([]), "");
});

// ─── cookie-kind providers ──────────────────────────────────────────────────

test("cookie-kind payload mirrors the header into apiKey and providerSpecificData", () => {
  // claude-web reads providerSpecificData.cookie; perplexity-web, grok-web and
  // blackbox-web read credentials.apiKey. Both must carry the same header or
  // one of the two reader families silently authenticates with nothing.
  const result = payload("claude-web", { sessionKey: "abc" }, [
    { name: "sessionKey", value: "abc" },
  ]);

  assert.equal(result.credential, "sessionKey=abc");
  assert.equal(result.apiKey, "sessionKey=abc");
  assert.equal(result.providerSpecificData.cookie, "sessionKey=abc");
  // claude-web's storage keys are ["cookie", "sessionKey"] — both carry the
  // same secret (the header), matching the bulk-import convention.
  assert.equal(result.providerSpecificData.sessionKey, "sessionKey=abc");
});

test("cookie-kind payload adds a captured cookie name that is not a storage key", () => {
  // blackbox-web declares storage keys ["cookie", "sessionToken",
  // "__Secure-authjs.session-token"] but its real session cookie is
  // `connect.sid`. The extra key is additive — it must not shadow the
  // storage-key convention above.
  const result = payload("blackbox-web", {}, [{ name: "connect.sid", value: "sid-value" }]);

  assert.equal(result.credential, "connect.sid=sid-value");
  assert.equal(result.apiKey, "connect.sid=sid-value");
  assert.equal(result.providerSpecificData.cookie, "connect.sid=sid-value");
  assert.equal(result.providerSpecificData.sessionToken, "connect.sid=sid-value");
  assert.equal(result.providerSpecificData["connect.sid"], "sid-value");
});

test("cookie-kind payload captures every cookie on the provider domain", () => {
  // grok.com needs `sso` AND `sso-rw` (the anti-bot rejects sso alone), and
  // cf_clearance is tied to the browser that earned it. Capturing only the
  // configured cookie names would drop both.
  const result = payload("grok-web", { sso: "s" }, [
    { name: "sso", value: "s" },
    { name: "sso-rw", value: "rw" },
    { name: "cf_clearance", value: "cf" },
  ]);

  assert.equal(result.credential, "sso=s; sso-rw=rw; cf_clearance=cf");
  assert.equal(result.apiKey, "sso=s; sso-rw=rw; cf_clearance=cf");
  assert.equal(result.providerSpecificData.cookie, "sso=s; sso-rw=rw; cf_clearance=cf");
});

test("cookie-kind payload falls back to the configured cookie sources", () => {
  // No full jar supplied — the builder must still assemble a header from the
  // provider's declared token sources.
  const result = payload("perplexity-web", {
    "__Secure-next-auth.session-token": "tok",
  });

  assert.equal(result.credential, "__Secure-next-auth.session-token=tok");
  assert.equal(result.apiKey, "__Secure-next-auth.session-token=tok");
  assert.equal(result.providerSpecificData.cookie, "__Secure-next-auth.session-token=tok");
});

test("cookie-kind payload is empty when nothing was captured", () => {
  const result = payload("claude-web", {}, []);
  assert.equal(result.credential, "");
  assert.equal(result.apiKey, null);
  assert.deepEqual(result.providerSpecificData, {});
});

// ─── token-kind providers ───────────────────────────────────────────────────

test("token-kind payload stores the bare token in apiKey", () => {
  // zai-web / deepseek-web / copilot-web read credentials.apiKey and add the
  // `Bearer ` prefix themselves — a JSON blob or a prefixed value breaks them.
  const result = payload("zai-web", { token: "eyJhbGciOi" });

  assert.equal(result.credential, "eyJhbGciOi");
  assert.equal(result.apiKey, "eyJhbGciOi");
  assert.equal(result.providerSpecificData.token, "eyJhbGciOi");
});

test("token-kind payload strips the Bearer prefix from a captured header", () => {
  // copilot-web's token source is the `Authorization` request header, which
  // arrives as `Bearer eyJ...`. The executor re-adds the prefix.
  const result = payload("copilot-web", { Authorization: "Bearer eyJtoken" });

  assert.equal(result.credential, "eyJtoken");
  assert.equal(result.apiKey, "eyJtoken");
  assert.equal(result.providerSpecificData.token, "eyJtoken");
  assert.equal(result.providerSpecificData.access_token, "eyJtoken");
});

test("token-kind payload prefers the localStorage token over the cookie fallback", () => {
  // kimi-web's access_token (localStorage) is primary; kimi-auth is only a
  // legacy fallback.
  const result = payload("kimi-web", {
    access_token: "AT",
    "kimi-auth": "CK",
  });

  assert.equal(result.credential, "AT");
  assert.equal(result.apiKey, "AT");
  assert.equal(result.providerSpecificData.access_token, "AT");
});

test("token-kind payload falls back to the cookie value when no token was captured", () => {
  const result = payload("deepseek-web", { "user-token": "UT" });
  assert.equal(result.credential, "UT");
  assert.equal(result.apiKey, "UT");
});

test("token-kind payload is empty when nothing was captured", () => {
  const result = payload("zai-web", {}, []);
  assert.equal(result.credential, "");
  assert.equal(result.apiKey, null);
  assert.deepEqual(result.providerSpecificData, {});
});

// ─── Providers without a browser sign-in requirement ────────────────────────

test("payload is empty for a provider with no web-session requirement", () => {
  const result = payload("openai", { cookie: "x" });
  assert.equal(result.credential, "");
  assert.equal(result.apiKey, null);
  assert.deepEqual(result.providerSpecificData, {});
});

// ─── Probe interpretation ────────────────────────────────────────────────────

test("a 401/403 probe result means the captured session expired", () => {
  assert.deepEqual(
    interpretCapturedSessionProbe({
      valid: false,
      error: "SESSION_EXPIRED",
      errorCode: "AUTH_007",
      unsupported: false,
    }),
    { valid: false, expired: true }
  );
  assert.deepEqual(interpretCapturedSessionProbe({ valid: false, errorCode: "AUTH_007" }), {
    valid: false,
    expired: true,
  });
});

test("an inconclusive probe result never invalidates a captured session", () => {
  // A provider without an auth probe, a network failure, or any other
  // non-auth status says nothing about the session — treating it as expired
  // would throw away a working sign-in.
  for (const result of [
    { valid: true, error: null, unsupported: false },
    { valid: false, error: "Provider not found in registry", unsupported: true },
    { valid: false, error: "Provider validation not supported", unsupported: true },
    { valid: false, error: "fetch failed", unsupported: false },
    null,
    undefined,
  ]) {
    assert.deepEqual(
      interpretCapturedSessionProbe(result),
      { valid: true, expired: false },
      `unexpected verdict for ${JSON.stringify(result)}`
    );
  }
});

test("only cookie providers (plus zai-web) can be judged by the session probe", () => {
  // The probe sends the credential as a `Cookie:` header. A bare token would
  // come back 401 and be wrongly reported as an expired session.
  assert.equal(isProbeableProvider("claude-web"), true);
  assert.equal(isProbeableProvider("perplexity-web"), true);
  assert.equal(isProbeableProvider("grok-web"), true);
  // zai-web's session is a bearer JWT the probe sends as `Authorization`.
  assert.equal(isProbeableProvider("zai-web"), true);

  assert.equal(isProbeableProvider("deepseek-web"), false);
  assert.equal(isProbeableProvider("kimi-web"), false);
  assert.equal(isProbeableProvider("copilot-web"), false);
  assert.equal(isProbeableProvider("openai"), false);
});
