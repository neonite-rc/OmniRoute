import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { resolveBrowserHintForRequest } from "../../../src/lib/api/browserHint.ts";

// The dashboard reports the browser it is running in. That only tells the
// host anything when the dashboard is open ON the host: a dashboard served to
// a laptop says nothing about what the server can open, so the host uses its
// own default browser there.
describe("resolveBrowserHintForRequest", () => {
  function requestWithHost(host: string | null): Request {
    return new Request("http://omniroute.local/api/providers/web-session-login", {
      headers: host === null ? {} : { host },
    });
  }

  test("honours the hint when the dashboard is on this host", () => {
    assert.equal(resolveBrowserHintForRequest(requestWithHost("localhost:20128"), "firefox"), "firefox");
    assert.equal(resolveBrowserHintForRequest(requestWithHost("127.0.0.1:20128"), "chrome"), "chrome");
    assert.equal(resolveBrowserHintForRequest(requestWithHost("[::1]:20128"), "edge"), "edge");
  });

  test("ignores the hint when the dashboard is on another machine", () => {
    assert.equal(resolveBrowserHintForRequest(requestWithHost("192.168.1.50:20128"), "firefox"), "unknown");
    assert.equal(resolveBrowserHintForRequest(requestWithHost("omniroute.example.com"), "firefox"), "unknown");
  });

  test("treats a missing Host header as local", () => {
    assert.equal(resolveBrowserHintForRequest(requestWithHost(null), "firefox"), "firefox");
  });

  test("keeps 'unknown' as 'unknown'", () => {
    assert.equal(resolveBrowserHintForRequest(requestWithHost("localhost:20128"), "unknown"), "unknown");
  });
});
