/**
 * Session retention + the issue prompts that ride on it.
 *
 * Two behaviours are pinned here:
 *
 *   1. RETENTION — a bot challenge is not an expired session. A provider that
 *      answers the probe with a Cloudflare/Turnstile page is blocking the
 *      REQUEST, not the session: the saved browser profile must survive it,
 *      because wiping it throws away a working sign-in over a challenge the
 *      operator can solve.
 *
 *   2. THE PROMPTS — an expiry and a challenge are recorded, a solved problem
 *      is resolved, and a solved problem never prompts again.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-web-session-retention-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "web-session-retention-test-secret";

const core = await import("../../../src/lib/db/core.ts");
const { capturedSessionProbe } = await import("../../../src/lib/providers/webSessionCapture.ts");
const { buildWebSessionCaptureResult } = await import(
  "../../../src/lib/providers/webSessionCaptureResult.ts"
);
const { interpretCapturedSessionProbe } = await import(
  "../../../src/lib/providers/webSessionCapture.ts"
);
const issuesService = await import("../../../src/lib/providers/webSessionIssues.ts");

const PROVIDER = "claude-web";

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── The probe verdict ────────────────────────────────────────────────────────

test("a challenge-blocked rejection is NOT an expired session", () => {
  const verdict = interpretCapturedSessionProbe({
    valid: false,
    error: "SESSION_EXPIRED",
    errorCode: "AUTH_007",
    challengeBlocked: true,
  });

  assert.equal(verdict.expired, false, "the session behind a challenge may still be alive");
  assert.equal(verdict.challengeBlocked, true);
});

test("a plain 401/403 IS an expired session", () => {
  const verdict = interpretCapturedSessionProbe({
    valid: false,
    error: "SESSION_EXPIRED",
    errorCode: "AUTH_007",
  });
  assert.equal(verdict.expired, true);
  assert.equal(verdict.challengeBlocked, undefined);
});

// ── The retention behaviour ──────────────────────────────────────────────────

test("a challenge keeps the saved browser profile", async () => {
  const marker = createProfileMarker(PROVIDER);

  await withProbe({ challengeBlocked: true, expired: false }, async () => {
    const result = await buildWebSessionCaptureResult(PROVIDER, signedInResult());
    assert.equal(result.success, false);
    assert.match(
      result.success === false ? result.error : "",
      /captcha/i,
      "the operator is told what is blocking the sign-in"
    );
  });

  assert.ok(
    fs.existsSync(marker),
    "the saved profile must survive a challenge — it is the working session"
  );
});

test("a real expiry drops the stale profile and records the problem", async () => {
  const marker = createProfileMarker(PROVIDER);

  await withProbe({ challengeBlocked: false, expired: true }, async () => {
    const result = await buildWebSessionCaptureResult(PROVIDER, signedInResult());
    assert.equal(result.success, false);
    assert.match(
      result.success === false ? result.error : "",
      /expired/i,
      "the operator is told the session expired"
    );
  });

  assert.equal(fs.existsSync(marker), false, "a dead profile is dropped");
  assert.equal(issuesService.listWebSessionIssueAlerts().length, 1, "the expiry is announced");
});

test("a successful capture resolves the open problem", async () => {
  issuesService.recordWebSessionIssue({ providerId: PROVIDER, kind: "session_expired" });
  assert.equal(issuesService.listWebSessionIssueAlerts().length, 1);

  const result = await buildWebSessionCaptureResult(PROVIDER, {
    success: true,
    credentials: { sessionKey: "abc" },
    cookies: [{ name: "sessionKey", value: "abc" }],
    alreadySignedIn: false,
  });

  assert.equal(result.success, true);
  assert.equal(
    issuesService.listWebSessionIssueAlerts().length,
    0,
    "a solved problem never prompts again"
  );
});

test("a captcha-blocked sign-in is recorded as a problem", async () => {
  const result = await buildWebSessionCaptureResult(PROVIDER, {
    success: false,
    error: "A Cloudflare challenge is blocking the sign-in.",
    errorCode: "captcha_required",
  });

  assert.equal(result.success, false);
  assert.equal(
    issuesService.listWebSessionIssueAlerts().length,
    0,
    "one blocked attempt is a blip, not a prompt"
  );

  // The second blocked attempt is the persistent problem.
  await buildWebSessionCaptureResult(PROVIDER, {
    success: false,
    error: "A Cloudflare challenge is blocking the sign-in.",
    errorCode: "captcha_required",
  });
  assert.equal(issuesService.listWebSessionIssueAlerts().length, 1);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A marker file inside the provider's saved browser profile. */
function createProfileMarker(provider: string): string {
  const dir = path.join(TEST_DATA_DIR, "browser-profiles", provider, "chromium");
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, "Cookies");
  fs.writeFileSync(marker, "saved-session");
  return marker;
}

function signedInResult() {
  return {
    success: true,
    credentials: { sessionKey: "abc" },
    cookies: [{ name: "sessionKey", value: "abc" }],
    alreadySignedIn: true,
  };
}

async function withProbe(
  verdict: { challengeBlocked: boolean; expired: boolean },
  fn: () => Promise<void>
): Promise<void> {
  const original = capturedSessionProbe.validate;
  capturedSessionProbe.validate = async () => ({
    valid: !verdict.expired,
    expired: verdict.expired,
    challengeBlocked: verdict.challengeBlocked,
  });
  try {
    await fn();
  } finally {
    capturedSessionProbe.validate = original;
  }
}
