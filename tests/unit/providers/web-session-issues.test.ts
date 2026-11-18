/**
 * The web-session issue tracker — the "one prompt per problem" contract.
 *
 * The operator asked for four things, and each one is a test here:
 *
 *   1. the prompt fires when the problem PERSISTS, not on the first blip,
 *   2. it fires ONCE per episode, not on every attempt,
 *   3. a solved problem stops prompting,
 *   4. a removed provider never prompts again.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-web-session-issues-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "web-session-issues-test-secret";

const core = await import("../../../src/lib/db/core.ts");
const issuesDb = await import("../../../src/lib/db/webSessionIssues.ts");
const issuesService = await import("../../../src/lib/providers/webSessionIssues.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── 1. The prompt fires when the problem persists ────────────────────────────

test("a captcha that blocks one attempt stays silent", () => {
  const { notify } = issuesService.recordWebSessionIssue({
    providerId: "claude-web",
    kind: "captcha_blocked",
  });
  assert.equal(notify, false, "a single blocked attempt is not a persistent problem");
  assert.equal(issuesService.listWebSessionIssueAlerts().length, 0);
});

test("a captcha that blocks the next attempt too raises the prompt", () => {
  issuesService.recordWebSessionIssue({ providerId: "claude-web", kind: "captcha_blocked" });
  const second = issuesService.recordWebSessionIssue({
    providerId: "claude-web",
    kind: "captcha_blocked",
  });
  assert.equal(second.notify, true, "the second occurrence is a persistent problem");

  const alerts = issuesService.listWebSessionIssueAlerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].providerId, "claude-web");
  assert.match(alerts[0].message, /captcha/i);
});

test("an expired session is definitive — the prompt fires at once", () => {
  const { notify } = issuesService.recordWebSessionIssue({
    providerId: "grok-web",
    kind: "session_expired",
  });
  assert.equal(notify, true, "a 401/403 is proof, not a blip");
  assert.equal(issuesService.listWebSessionIssueAlerts().length, 1);
});

// ── 2. The prompt fires once per episode ─────────────────────────────────────

test("the same episode never prompts twice", () => {
  issuesService.recordWebSessionIssue({ providerId: "grok-web", kind: "session_expired" });
  const second = issuesService.recordWebSessionIssue({
    providerId: "grok-web",
    kind: "session_expired",
  });
  const third = issuesService.recordWebSessionIssue({
    providerId: "grok-web",
    kind: "session_expired",
  });

  assert.equal(second.notify, false);
  assert.equal(third.notify, false);
  assert.equal(issuesService.listWebSessionIssueAlerts().length, 1, "still one prompt");
});

test("the occurrence count keeps growing across attempts", () => {
  issuesService.recordWebSessionIssue({ providerId: "grok-web", kind: "captcha_blocked" });
  issuesService.recordWebSessionIssue({ providerId: "grok-web", kind: "captcha_blocked" });
  const third = issuesService.recordWebSessionIssue({
    providerId: "grok-web",
    kind: "captcha_blocked",
  });
  assert.equal(third.issue.occurrences, 3);
});

// ── 3. A solved problem stops prompting ──────────────────────────────────────

test("a successful sign-in resolves the open issue", () => {
  issuesService.recordWebSessionIssue({ providerId: "claude-web", kind: "session_expired" });
  assert.equal(issuesService.listWebSessionIssueAlerts().length, 1);

  issuesService.resolveWebSessionIssues("claude-web");

  assert.equal(issuesService.listWebSessionIssueAlerts().length, 0, "a solved problem is silent");
  assert.equal(issuesDb.listOpenWebSessionIssues().length, 0);
});

test("a problem that comes back after being solved opens a NEW episode", () => {
  issuesService.recordWebSessionIssue({ providerId: "claude-web", kind: "session_expired" });
  issuesService.resolveWebSessionIssues("claude-web");

  const again = issuesService.recordWebSessionIssue({
    providerId: "claude-web",
    kind: "session_expired",
  });
  assert.equal(again.notify, true, "a NEW problem deserves a new prompt");
  assert.equal(again.issue.occurrences, 1, "the new episode starts from one");
});

test("a dismissed prompt does not come back", () => {
  const { issue } = issuesService.recordWebSessionIssue({
    providerId: "claude-web",
    kind: "session_expired",
  });
  issuesService.acknowledgeWebSessionIssueAlert(issue.id);
  assert.equal(issuesService.listWebSessionIssueAlerts().length, 0);

  // A further occurrence in the same episode stays silent.
  const again = issuesService.recordWebSessionIssue({
    providerId: "claude-web",
    kind: "session_expired",
  });
  assert.equal(again.notify, false);
  assert.equal(issuesService.listWebSessionIssueAlerts().length, 0);
});

// ── 4. A removed provider never prompts again ─────────────────────────────────

test("removing the provider forgets its issues", async () => {
  issuesService.recordWebSessionIssue({ providerId: "claude-web", kind: "session_expired" });
  assert.equal(issuesService.listWebSessionIssueAlerts().length, 1);

  await providersDb.deleteProviderConnection(
    await makeConnection("claude-web")
  );

  assert.equal(
    issuesService.listWebSessionIssueAlerts().length,
    0,
    "a removed provider must never prompt again"
  );
  assert.equal(issuesDb.listOpenWebSessionIssues().length, 0);
});

test("removing every connection of a provider forgets its issues", async () => {
  issuesService.recordWebSessionIssue({ providerId: "claude-web", kind: "captcha_blocked" });
  issuesService.recordWebSessionIssue({ providerId: "claude-web", kind: "captcha_blocked" });
  assert.equal(issuesService.listWebSessionIssueAlerts().length, 1);

  const id = await makeConnection("claude-web");
  await providersDb.deleteProviderConnectionsByProvider("claude-web");

  assert.equal(issuesService.listWebSessionIssueAlerts().length, 0);
  assert.ok(id);
});

// ── The storage itself ───────────────────────────────────────────────────────

test("the open episode is reused across occurrences", () => {
  const first = issuesDb.upsertWebSessionIssue({
    providerId: "gemini-web",
    kind: "captcha_blocked",
  });
  const second = issuesDb.upsertWebSessionIssue({
    providerId: "gemini-web",
    kind: "captcha_blocked",
  });

  assert.equal(first.id, second.id, "the same episode, not a second row");
  assert.equal(second.occurrences, 2);
  assert.ok(second.firstSeenAt <= second.lastSeenAt);
});

test("a resolved episode is closed and a new one opens", () => {
  const first = issuesDb.upsertWebSessionIssue({
    providerId: "gemini-web",
    kind: "captcha_blocked",
  });
  issuesDb.resolveWebSessionIssues("gemini-web");
  const second = issuesDb.upsertWebSessionIssue({
    providerId: "gemini-web",
    kind: "captcha_blocked",
  });

  assert.notEqual(first.id, second.id);
  assert.equal(second.occurrences, 1);
  assert.equal(issuesDb.getWebSessionIssue(first.id)?.resolvedAt !== null, true);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function makeConnection(provider: string): Promise<string> {
  const connection = await providersDb.createProviderConnection({
    provider,
    authType: "web-cookie",
    name: `issues-test-${provider}`,
    apiKey: "",
    isActive: true,
  });
  return String((connection as { id: string | number }).id);
}
