import test, { describe, beforeEach, afterEach } from "node:test";
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

// The stamped socket peer is the trustworthy signal: the browser is on this
// machine when the connection came from loopback or from one of the host's
// own addresses (a same-machine request that went through the LAN address).
describe("resolveBrowserHintForRequest with the stamped peer", () => {
  const TOKEN = "test-peer-stamp-token";
  let previousToken: string | undefined;

  beforeEach(() => {
    previousToken = process.env.OMNIROUTE_PEER_STAMP_TOKEN;
    process.env.OMNIROUTE_PEER_STAMP_TOKEN = TOKEN;
  });

  afterEach(() => {
    if (previousToken === undefined) delete process.env.OMNIROUTE_PEER_STAMP_TOKEN;
    else process.env.OMNIROUTE_PEER_STAMP_TOKEN = previousToken;
  });

  function stampedRequest(peer: string, viaProxy = false, host = "omniroute.example.com"): Request {
    const headers: Record<string, string> = {
      host,
      "x-omniroute-peer-ip": `${TOKEN}|${peer}`,
    };
    if (viaProxy) headers["x-omniroute-via-proxy"] = `${TOKEN}|1`;
    return new Request("http://omniroute.local/api/providers/web-session-login", { headers });
  }

  test("honours the hint for a loopback peer, whatever the Host header says", () => {
    assert.equal(resolveBrowserHintForRequest(stampedRequest("127.0.0.1"), "firefox"), "firefox");
    assert.equal(resolveBrowserHintForRequest(stampedRequest("::1"), "firefox"), "firefox");
  });

  test("ignores the hint for a peer on another machine", () => {
    assert.equal(resolveBrowserHintForRequest(stampedRequest("203.0.113.9"), "firefox"), "unknown");
  });

  test("ignores the hint behind a reverse proxy", () => {
    // The socket peer is the proxy hop, not the operator's browser.
    assert.equal(resolveBrowserHintForRequest(stampedRequest("127.0.0.1", true), "firefox"), "unknown");
  });

  test("ignores a forged stamp without the token", () => {
    const forged = new Request("http://omniroute.local/api/providers/web-session-login", {
      headers: { host: "omniroute.example.com", "x-omniroute-peer-ip": "wrong-token|127.0.0.1" },
    });
    assert.equal(resolveBrowserHintForRequest(forged, "firefox"), "unknown");
  });
});
