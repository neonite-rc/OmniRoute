/**
 * Captcha / bot-challenge detection for the browser sign-in.
 *
 * The classifier has to be conservative in one direction only: a normal login
 * page must never be reported as blocked (that would abort a sign-in that was
 * about to work), while a real interstitial must be recognised (otherwise the
 * operator only ever sees "Login timed out").
 *
 * These tests pin both directions, plus the page reader that feeds it.
 */

import test from "node:test";
import assert from "node:assert/strict";

const {
  detectCaptchaChallenge,
  detectCaptchaInBody,
  detectCaptchaOnPage,
  describeCaptchaBlock,
} = await import("../../../open-sse/services/webSessionCaptcha.ts");

// ── A normal login page is NOT a challenge ───────────────────────────────────

test("a normal login page is not reported as a challenge", () => {
  assert.equal(
    detectCaptchaChallenge({
      title: "Log in to your Claude account",
      url: "https://claude.ai/login",
      bodyText: "Email address Password Continue to Claude",
    }),
    null
  );
});

test("a login page that merely embeds a captcha widget is not a challenge", () => {
  // The widget NAME in the body is not evidence — every login page with a
  // captcha widget mentions it. Only an interstitial counts.
  assert.equal(
    detectCaptchaChallenge({
      title: "Sign in",
      url: "https://example.com/login",
      bodyText:
        'Please sign in <div class="g-recaptcha" data-sitekey="x"></div> ' +
        '<script src="https://www.google.com/recaptcha/api.js"></script>',
    }),
    null
  );
});

test("an ordinary 403 body is not a challenge", () => {
  assert.equal(detectCaptchaInBody('{"error":{"message":"Forbidden"}}'), null);
  assert.equal(detectCaptchaInBody("Access denied"), null);
});

// ── A real challenge IS detected ─────────────────────────────────────────────

test("the Cloudflare interstitial is detected by title, URL and body", () => {
  assert.equal(detectCaptchaChallenge({ title: "Just a moment..." })?.label, "Cloudflare");
  assert.equal(
    detectCaptchaChallenge({ url: "https://example.com/cdn-cgi/challenge-platform/h/b" })?.label,
    "Cloudflare"
  );
  assert.equal(
    detectCaptchaChallenge({ bodyText: "Checking your browser before accessing example.com" })
      ?.label,
    "a browser check"
  );
});

test("a human-verification page is detected", () => {
  const match = detectCaptchaChallenge({ title: "Verify you are human" });
  assert.ok(match);
  assert.match(match.label, /human-verification/);
});

test("Google's traffic interstitial is detected", () => {
  assert.equal(
    detectCaptchaChallenge({ url: "https://www.google.com/sorry/index?continue=x" })?.label,
    "a traffic check"
  );
});

test("the Cloudflare interstitial body is detected", () => {
  assert.equal(
    detectCaptchaInBody("<html><head><title>Just a moment...</title></head><body></body></html>")
      ?.label,
    "Cloudflare"
  );
  assert.equal(
    detectCaptchaInBody("<script>window._cf_chl_opt={}</script>")?.label,
    "Cloudflare"
  );
});

test("an empty page is not a challenge", () => {
  assert.equal(detectCaptchaChallenge({}), null);
  assert.equal(detectCaptchaChallenge({ title: "", url: "", bodyText: "" }), null);
  assert.equal(detectCaptchaInBody(null), null);
});

// ── The page reader ──────────────────────────────────────────────────────────

test("the page reader inspects the title, the URL and the visible text", async () => {
  const page = {
    title: async () => "Just a moment...",
    url: () => "https://example.com/",
    evaluate: async () => "",
  };
  const match = await detectCaptchaOnPage(page);
  assert.ok(match);
  assert.equal(match.label, "Cloudflare");
});

test("the page reader finds a challenge that only the body shows", async () => {
  const page = {
    title: async () => "Sign in",
    url: () => "https://example.com/login",
    evaluate: async () => "Checking your browser before accessing example.com",
  };
  const match = await detectCaptchaOnPage(page);
  assert.ok(match);
  assert.equal(match.label, "a browser check");
});

test("the page reader survives a page it cannot inspect", async () => {
  assert.equal(await detectCaptchaOnPage(null), null);
  assert.equal(
    await detectCaptchaOnPage({
      title: async () => {
        throw new Error("detached");
      },
      url: () => {
        throw new Error("detached");
      },
      evaluate: async () => {
        throw new Error("detached");
      },
    }),
    null
  );
});

// ── The operator-facing message ──────────────────────────────────────────────

test("the block message says where to solve the challenge", () => {
  const message = describeCaptchaBlock({ id: "x", label: "Cloudflare" });
  assert.match(message, /Cloudflare/);
  assert.match(message, /sign-in window/i);
});
