import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { describeBrowserLaunchFailure } from "../../../open-sse/services/inAppLoginService.ts";

// The raw Playwright launch failure is a multi-kilobyte dump: the browser
// command line, the launch call log and a boxed banner. The dashboard must
// never show that — and the single most common cause (no display on the
// OmniRoute host) has to be actionable.
describe("describeBrowserLaunchFailure", () => {
  test("explains a missing display instead of leaking the Playwright dump", () => {
    const raw = [
      "browserType.launch: Target page, context or browser has been closed",
      "Browser logs:",
      "╔══════════════════════════════════════════════════════════╗",
      "║ Looks like you launched a headed browser without having a XServer running.",
      "╚══════════════════════════════════════════════════════════╝",
      "Call log:",
      "  - <launching> /home/user/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome --no-sandbox",
      "  - [pid=622684][err] Missing X server or $DISPLAY",
    ].join("\n");

    const message = describeBrowserLaunchFailure(new Error(raw));

    assert.match(message, /no display/i);
    assert.match(message, /xvfb-run/i);
    assert.match(message, /paste the session credential manually/i);
    assert.ok(!message.includes("chrome-linux64"), "must not leak the browser command line");
    assert.ok(!message.includes("Call log"), "must not leak the Playwright call log");
  });

  test("points at the browser install when Playwright has no browser", () => {
    const message = describeBrowserLaunchFailure(
      new Error("Executable doesn't exist at /root/.cache/ms-playwright/chromium-1/chrome\nPlease run the following command to download new browsers:\nnpx playwright install")
    );

    assert.match(message, /npx playwright install chromium/);
    assert.match(message, /paste the session credential manually/i);
  });

  test("explains a permission problem", () => {
    const message = describeBrowserLaunchFailure(new Error("spawn EACCES: permission denied"));

    assert.match(message, /permission denied/i);
    assert.match(message, /paste the session credential manually/i);
  });

  test("keeps an unknown failure short and on one line", () => {
    const message = describeBrowserLaunchFailure(new Error("boom\nsecond line\nthird line"));

    assert.match(message, /Could not open the sign-in browser: boom/);
    assert.ok(!message.includes("second line"), "must not dump the whole stack");
  });

  test("handles a non-Error rejection", () => {
    const message = describeBrowserLaunchFailure("Missing X server or $DISPLAY");

    assert.match(message, /no display/i);
  });

  // The operator asked for a specific browser; telling them to install
  // Chromium when they are on Firefox sends them down the wrong path.
  test("names the browser that is actually missing", () => {
    const missing = new Error(
      "Executable doesn't exist at /home/user/.cache/ms-playwright/firefox-1538/firefox/firefox"
    );

    const firefoxMessage = describeBrowserLaunchFailure(missing, "firefox");
    assert.match(firefoxMessage, /Firefox/);
    assert.match(firefoxMessage, /npx playwright install firefox/);
    assert.ok(!/install chromium/.test(firefoxMessage), "must not point at Chromium");

    const webkitMessage = describeBrowserLaunchFailure(missing, "webkit");
    assert.match(webkitMessage, /npx playwright install webkit/);

    const chromiumMessage = describeBrowserLaunchFailure(missing, "chromium");
    assert.match(chromiumMessage, /npx playwright install chromium/);
  });
});
