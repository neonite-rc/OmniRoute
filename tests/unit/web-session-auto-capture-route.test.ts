/**
 * Regression suite for the browser sign-in capture path.
 *
 * The generic web-session login path used to persist the raw extraction map:
 *
 *   apiKey             = JSON.stringify(credentials)   // e.g. '{"sessionKey":"abc"}'
 *   providerSpecificData = credentials                  // e.g. { sessionKey: "abc" }
 *
 * Neither shape is a credential the executors can use. perplexity-web,
 * grok-web and blackbox-web read `credentials.apiKey` and treat it as a Cookie
 * header, while claude-web and notion-web read `providerSpecificData.cookie`.
 * A JSON blob breaks the `name=value` match in `normalizeSessionCookieHeader`
 * / `buildSessionCookieHeader`, so a successful capture authenticated with
 * nothing at request time.
 *
 * These tests drive the real route handlers against a real DB with the browser
 * launch stubbed out, and pin the canonical shape:
 *
 *   - cookie-kind: `apiKey` carries the full Cookie header AND
 *     `providerSpecificData.cookie` carries the same header.
 *   - token-kind:  `apiKey` carries the bare token (no `Bearer ` prefix, no
 *     JSON), mirrored into `providerSpecificData` under the storage keys.
 *
 * They also pin that a re-sync MERGES providerSpecificData instead of wiping
 * the settings the operator configured, and that the raw credential never
 * appears in a response body.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { NextRequest } from "next/server";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-web-session-capture-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "web-session-capture-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const loginRoute = await import("../../src/app/api/providers/[id]/login/route.ts");
const captureRoute = await import("../../src/app/api/providers/web-session-login/route.ts");
const { inAppLoginService } = await import("../../open-sse/services/inAppLoginService.ts");
const { capturedSessionProbe } = await import("../../src/lib/providers/webSessionCapture.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

interface StubbedLogin {
  success: boolean;
  credentials?: Record<string, string>;
  cookies?: Array<{ name: string; value: string }>;
  alreadySignedIn?: boolean;
  error?: string;
}

/** Replace the browser launch with a stub for the duration of `fn`. */
async function withStubbedLogin(result: StubbedLogin, fn: () => Promise<void>): Promise<void> {
  const original = inAppLoginService.startLogin.bind(inAppLoginService);
  inAppLoginService.startLogin = async () => result;
  try {
    await fn();
  } finally {
    inAppLoginService.startLogin = original;
  }
}

function loginRequest(id: string, body: unknown = {}): NextRequest {
  return new Request(`http://localhost/api/providers/${id}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function captureRequest(body: unknown): NextRequest {
  return new Request("http://localhost/api/providers/web-session-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

async function makeConnection(
  provider: string,
  providerSpecificData?: Record<string, unknown>
): Promise<string> {
  const connection = await providersDb.createProviderConnection({
    provider,
    authType: "web-cookie",
    name: `capture-test-${provider}`,
    apiKey: "",
    isActive: true,
    ...(providerSpecificData ? { providerSpecificData } : {}),
  });
  return String((connection as { id: string | number }).id);
}

// ── POST /api/providers/{id}/login — the persisted shape ────────────────────

test("login persists a usable Cookie header, not the raw extraction map", async () => {
  const id = await makeConnection("claude-web");

  await withStubbedLogin(
    {
      success: true,
      credentials: { sessionKey: "abc" },
      cookies: [{ name: "sessionKey", value: "abc" }],
    },
    async () => {
      const res = await loginRoute.POST(loginRequest(id), {
        params: Promise.resolve({ id }),
      });
      assert.equal(res.status, 200);
    }
  );

  const stored = (await providersDb.getProviderConnectionById(id)) as Record<string, unknown>;
  const psd = stored.providerSpecificData as Record<string, unknown>;

  // perplexity-web / grok-web / blackbox-web read `credentials.apiKey` as a
  // Cookie header — it must be the header, never a JSON blob.
  assert.equal(stored.apiKey, "sessionKey=abc");
  assert.notEqual(stored.apiKey, '{"sessionKey":"abc"}');

  // claude-web / notion-web read `providerSpecificData.cookie`.
  assert.equal(psd.cookie, "sessionKey=abc");

  // claude-web's declared storage keys carry the same secret.
  assert.equal(psd.sessionKey, "sessionKey=abc");
});

test("login captures every cookie on the provider domain, not only the declared one", async () => {
  // grok.com needs `sso` AND `sso-rw` (#3063) and pins `cf_clearance` to the
  // browser that earned it. Capturing only the declared cookie names drops both.
  const id = await makeConnection("grok-web");

  await withStubbedLogin(
    {
      success: true,
      credentials: { sso: "s" },
      cookies: [
        { name: "sso", value: "s" },
        { name: "sso-rw", value: "rw" },
        { name: "cf_clearance", value: "cf" },
      ],
    },
    async () => {
      const res = await loginRoute.POST(loginRequest(id), {
        params: Promise.resolve({ id }),
      });
      assert.equal(res.status, 200);
    }
  );

  const stored = (await providersDb.getProviderConnectionById(id)) as Record<string, unknown>;
  assert.equal(stored.apiKey, "sso=s; sso-rw=rw; cf_clearance=cf");
});

test("login stores the bare token for a token-kind provider", async () => {
  // zai-web / deepseek-web / copilot-web read `credentials.apiKey` and add the
  // `Bearer ` prefix themselves — a JSON blob or a prefixed value breaks them.
  const id = await makeConnection("zai-web");

  await withStubbedLogin(
    {
      success: true,
      credentials: { token: "eyJhbGciOi" },
    },
    async () => {
      const res = await loginRoute.POST(loginRequest(id), {
        params: Promise.resolve({ id }),
      });
      assert.equal(res.status, 200);
    }
  );

  const stored = (await providersDb.getProviderConnectionById(id)) as Record<string, unknown>;
  const psd = stored.providerSpecificData as Record<string, unknown>;

  assert.equal(stored.apiKey, "eyJhbGciOi");
  assert.equal(psd.token, "eyJhbGciOi");
});

test("login MERGES providerSpecificData instead of wiping it", async () => {
  // The captured session must not destroy settings the operator configured on
  // this connection (custom user agent, proxy, quota thresholds, ...).
  const id = await makeConnection("claude-web", { customUserAgent: "my-agent/1.0" });

  await withStubbedLogin(
    {
      success: true,
      credentials: { sessionKey: "abc" },
      cookies: [{ name: "sessionKey", value: "abc" }],
    },
    async () => {
      const res = await loginRoute.POST(loginRequest(id), {
        params: Promise.resolve({ id }),
      });
      assert.equal(res.status, 200);
    }
  );

  const stored = (await providersDb.getProviderConnectionById(id)) as Record<string, unknown>;
  const psd = stored.providerSpecificData as Record<string, unknown>;

  assert.equal(psd.customUserAgent, "my-agent/1.0");
  assert.equal(psd.cookie, "sessionKey=abc");
});

test("login response does not leak the captured credential", async () => {
  const id = await makeConnection("claude-web");

  await withStubbedLogin(
    {
      success: true,
      credentials: { sessionKey: "super-secret-session" },
      cookies: [{ name: "sessionKey", value: "super-secret-session" }],
    },
    async () => {
      const res = await loginRoute.POST(loginRequest(id), {
        params: Promise.resolve({ id }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(!text.includes("super-secret-session"), "raw credential leaked in the response");
    }
  );
});

test("login reports a capture that yielded nothing usable", async () => {
  const id = await makeConnection("claude-web");

  await withStubbedLogin({ success: true, credentials: {} }, async () => {
    const res = await loginRoute.POST(loginRequest(id), {
      params: Promise.resolve({ id }),
    });
    assert.equal(res.status, 400);
  });
});

// ── POST /api/providers/web-session-login — the capture-only flow ───────────

test("capture returns the canonical payload without persisting anything", async () => {
  await withStubbedLogin(
    {
      success: true,
      credentials: { sessionKey: "abc" },
      cookies: [{ name: "sessionKey", value: "abc" }],
    },
    async () => {
      const res = await captureRoute.POST(captureRequest({ provider: "claude-web" }));
      assert.equal(res.status, 200);

      const body = (await res.json()) as {
        success: boolean;
        persisted: boolean;
        credential: string;
        apiKey: string | null;
        providerSpecificData: Record<string, unknown>;
      };

      assert.equal(body.success, true);
      assert.equal(body.persisted, false);
      assert.equal(body.credential, "sessionKey=abc");
      assert.equal(body.apiKey, "sessionKey=abc");
      assert.equal(body.providerSpecificData.cookie, "sessionKey=abc");
    }
  );
});

test("capture rejects a provider with no known login flow", async () => {
  await withStubbedLogin({ success: true, credentials: { token: "x" } }, async () => {
    const res = await captureRoute.POST(captureRequest({ provider: "openai" }));
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /not available/i);
  });
});

test("capture validates the request body", async () => {
  const res = await captureRoute.POST(captureRequest({ provider: "" }));
  assert.equal(res.status, 400);
});

// ── A re-synced session that the provider has since invalidated ─────────────

test("login refuses a re-synced session the provider has expired", async () => {
  // The saved browser profile can hold a session the provider has since
  // invalidated. Storing it again would keep a dead credential in place and
  // report a successful sync — the operator must be told to sign in again.
  const id = await makeConnection("claude-web");

  const originalProbe = capturedSessionProbe.validate;
  capturedSessionProbe.validate = async () => ({ valid: false, expired: true });
  try {
    await withStubbedLogin(
      {
        success: true,
        credentials: { sessionKey: "stale" },
        cookies: [{ name: "sessionKey", value: "stale" }],
        alreadySignedIn: true,
      },
      async () => {
        const res = await loginRoute.POST(loginRequest(id), {
          params: Promise.resolve({ id }),
        });
        assert.equal(res.status, 400);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /expired/i);
      }
    );
  } finally {
    capturedSessionProbe.validate = originalProbe;
  }

  // The dead credential must not have been stored.
  const stored = (await providersDb.getProviderConnectionById(id)) as Record<string, unknown>;
  assert.notEqual(stored.apiKey, "sessionKey=stale");
});

test("login keeps a re-synced session the probe cannot rule out", async () => {
  // An inconclusive probe (provider down, no auth probe, network error) must
  // NOT discard a captured session — that would throw away a working sign-in.
  const id = await makeConnection("claude-web");

  const originalProbe = capturedSessionProbe.validate;
  capturedSessionProbe.validate = async () => ({ valid: true, expired: false });
  try {
    await withStubbedLogin(
      {
        success: true,
        credentials: { sessionKey: "fresh" },
        cookies: [{ name: "sessionKey", value: "fresh" }],
        alreadySignedIn: true,
      },
      async () => {
        const res = await loginRoute.POST(loginRequest(id), {
          params: Promise.resolve({ id }),
        });
        assert.equal(res.status, 200);
      }
    );
  } finally {
    capturedSessionProbe.validate = originalProbe;
  }

  const stored = (await providersDb.getProviderConnectionById(id)) as Record<string, unknown>;
  assert.equal(stored.apiKey, "sessionKey=fresh");
});
