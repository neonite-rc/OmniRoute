/**
 * Security regression: `POST /api/providers/web-session-login` is the
 * capture-only browser sign-in used while ADDING a web-session connection. It
 * launches a headful Chromium (a child process) exactly like
 * `POST /api/providers/[id]/login`, so it MUST be classified LOCAL_ONLY —
 * loopback enforcement runs unconditionally before any auth check, so a leaked
 * JWT over a Cloudflared/Ngrok tunnel cannot trigger a browser spawn.
 * Hard Rules #15 + #17. See docs/security/ROUTE_GUARD_TIERS.md.
 *
 * The route is a STATIC path (no dynamic `[id]` segment), but it still lives
 * under `/api/providers/`, which must stay remotely reachable for ordinary
 * provider CRUD — hence a narrow exact-path pattern rather than a prefix.
 *
 * It must ALSO be in the spawn-capable deny-list so it can never be made
 * bypassable through the manage-scope bypass settings.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isLocalOnlyPath } from "../../src/server/authz/routeGuard.ts";
import { SPAWN_CAPABLE_PATTERNS } from "../../src/shared/constants/spawnCapablePrefixes.ts";

test("/api/providers/web-session-login is LOCAL_ONLY (spawns Playwright Chromium)", () => {
  assert.equal(isLocalOnlyPath("/api/providers/web-session-login"), true);
});

test("/api/providers/web-session-login with a trailing slash is LOCAL_ONLY", () => {
  assert.equal(isLocalOnlyPath("/api/providers/web-session-login/"), true);
});

test("the web-session-login gate does NOT over-match the rest of /api/providers", () => {
  // Ordinary provider management must stay remotely reachable.
  assert.equal(isLocalOnlyPath("/api/providers"), false);
  assert.equal(isLocalOnlyPath("/api/providers/"), false);
  assert.equal(isLocalOnlyPath("/api/providers/claude-web"), false);
  assert.equal(isLocalOnlyPath("/api/providers/claude-web/test"), false);
  // Anchored: extra segments after the route are not the spawn route.
  assert.equal(isLocalOnlyPath("/api/providers/web-session-login/extra"), false);
});

test("/api/providers/web-session-login is deny-listed as spawn-capable", () => {
  // Being LOCAL_ONLY is not enough: the manage-scope bypass list must never be
  // able to re-open this path to remote callers.
  const matched = SPAWN_CAPABLE_PATTERNS.some((pattern) =>
    pattern.test("/api/providers/web-session-login")
  );
  assert.equal(matched, true);
});
