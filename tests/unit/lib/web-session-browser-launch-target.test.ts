import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { resolveBrowserLaunchTarget } from "../../../open-sse/services/inAppLoginService.ts";

// The operator signs in where they already are. The dashboard reports the
// browser it detected in its own user agent, and the sign-in window opens in
// that family — their Firefox, their Chrome, their Edge. Safari exposes no
// automation API, so its engine (WebKit) is used instead.
describe("resolveBrowserLaunchTarget", () => {
  test("honours a Firefox request", async () => {
    const target = await resolveBrowserLaunchTarget("firefox");
    assert.equal(target.browserName, "firefox");
    assert.equal(target.label, "Firefox");
    assert.equal(target.preferredEngine, "firefox");
  });

  test("honours a Safari request by using WebKit", async () => {
    const target = await resolveBrowserLaunchTarget("safari");
    assert.equal(target.browserName, "webkit");
    assert.equal(target.label, "Safari (WebKit)");
    assert.equal(target.preferredEngine, "webkit");
  });

  test("honours a Chrome request with a Chromium window", async () => {
    const target = await resolveBrowserLaunchTarget("chrome");
    assert.equal(target.browserName, "chromium");
    assert.equal(target.preferredEngine, "chromium");
    assert.ok(target.label.length > 0);
  });

  test("honours an Edge request with a Chromium window", async () => {
    const target = await resolveBrowserLaunchTarget("edge");
    assert.equal(target.browserName, "chromium");
    assert.equal(target.preferredEngine, "chromium");
    assert.ok(target.label.length > 0);
  });

  test("falls back to the host default when no browser was requested", async () => {
    const target = await resolveBrowserLaunchTarget("unknown");
    assert.ok(["chromium", "firefox", "webkit"].includes(target.browserName));
    // Without a request the host's own default is the guide, so the label
    // must name a real browser.
    assert.ok(target.label.length > 0);
  });

  test("falls back to the host default when the request is missing entirely", async () => {
    const target = await resolveBrowserLaunchTarget();
    assert.ok(["chromium", "firefox", "webkit"].includes(target.browserName));
    assert.ok(target.label.length > 0);
  });
});
