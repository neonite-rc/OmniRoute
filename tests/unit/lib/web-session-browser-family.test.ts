import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  detectBrowserFamily,
  normalizeBrowserFamily,
} from "../../../src/shared/providers/browserFamily.ts";

// The dashboard tells the server which browser the operator is looking at, so
// the sign-in window opens in that browser instead of a foreign Chromium.
// The mapping has to be right for every family — Edge and Chrome both claim
// to be Safari, and Chrome's iOS build does not say "Chrome/" at all.
describe("detectBrowserFamily", () => {
  test("recognises Firefox", () => {
    assert.equal(
      detectBrowserFamily(
        "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0"
      ),
      "firefox"
    );
  });

  test("recognises Chrome on desktop and iOS", () => {
    assert.equal(
      detectBrowserFamily(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
      ),
      "chrome"
    );
    assert.equal(
      detectBrowserFamily(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/151.0.0.0 Mobile/15E148 Safari/604.1"
      ),
      "chrome"
    );
  });

  test("recognises Edge before Chrome — Edge advertises Chrome too", () => {
    assert.equal(
      detectBrowserFamily(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0"
      ),
      "edge"
    );
  });

  test("recognises Safari", () => {
    assert.equal(
      detectBrowserFamily(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
      ),
      "safari"
    );
  });

  test("falls back to unknown for anything else", () => {
    assert.equal(detectBrowserFamily(""), "unknown");
    assert.equal(detectBrowserFamily("curl/8.4.0"), "unknown");
  });
});

describe("normalizeBrowserFamily", () => {
  test("accepts the known families", () => {
    assert.equal(normalizeBrowserFamily("firefox"), "firefox");
    assert.equal(normalizeBrowserFamily("chrome"), "chrome");
    assert.equal(normalizeBrowserFamily("edge"), "edge");
    assert.equal(normalizeBrowserFamily("safari"), "safari");
    assert.equal(normalizeBrowserFamily("unknown"), "unknown");
  });

  test("rejects anything else instead of trusting the request body", () => {
    assert.equal(normalizeBrowserFamily("chromium"), "unknown");
    assert.equal(normalizeBrowserFamily("FIREFOX"), "unknown");
    assert.equal(normalizeBrowserFamily(42), "unknown");
    assert.equal(normalizeBrowserFamily(null), "unknown");
    assert.equal(normalizeBrowserFamily({}), "unknown");
  });
});
