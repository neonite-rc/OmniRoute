import test, { describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";

import {
  resolveBrowserHintForRequest,
  resolveDashboardLocality,
  resolveSignInMode,
} from "../../../src/lib/api/browserHint.ts";

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
    assert.equal(
      resolveBrowserHintForRequest(requestWithHost("localhost:20128"), "firefox"),
      "firefox"
    );
    assert.equal(
      resolveBrowserHintForRequest(requestWithHost("127.0.0.1:20128"), "chrome"),
      "chrome"
    );
    assert.equal(resolveBrowserHintForRequest(requestWithHost("[::1]:20128"), "edge"), "edge");
  });

  test("ignores the hint when the dashboard is on another machine", () => {
    assert.equal(
      resolveBrowserHintForRequest(requestWithHost("192.168.1.50:20128"), "firefox"),
      "unknown"
    );
    assert.equal(
      resolveBrowserHintForRequest(requestWithHost("omniroute.example.com"), "firefox"),
      "unknown"
    );
  });

  test("treats a missing Host header as local", () => {
    assert.equal(resolveBrowserHintForRequest(requestWithHost(null), "firefox"), "firefox");
  });

  test("keeps 'unknown' as 'unknown'", () => {
    assert.equal(
      resolveBrowserHintForRequest(requestWithHost("localhost:20128"), "unknown"),
      "unknown"
    );
  });
});

// The authz pipeline forwards a trusted locality verdict, computed from the
// real TCP peer and stripped from client input. It is what route handlers
// must use — the Host header alone cannot tell "the same machine, reached
// through its LAN address" from "another machine on the network".
describe("resolveBrowserHintForRequest with the trusted locality verdict", () => {
  function trustedRequest(
    locality: string,
    peerIp?: string,
    host = "omniroute.example.com"
  ): Request {
    const headers: Record<string, string> = {
      host,
      "x-omniroute-peer-locality": locality,
    };
    if (peerIp) headers["x-omniroute-trusted-peer-ip"] = peerIp;
    return new Request("http://omniroute.local/api/providers/web-session-login", { headers });
  }

  test("honours the hint for a loopback peer, whatever the Host header says", () => {
    assert.equal(resolveBrowserHintForRequest(trustedRequest("loopback"), "firefox"), "firefox");
  });

  test("ignores the hint for a peer on another machine", () => {
    assert.equal(resolveBrowserHintForRequest(trustedRequest("remote"), "firefox"), "unknown");
    assert.equal(resolveBrowserHintForRequest(trustedRequest("lan"), "firefox"), "unknown");
  });

  test("honours the hint when the peer is one of this host's own addresses", () => {
    // The browser is on this machine and reached OmniRoute through the
    // machine's own LAN address.
    const ownAddress = Object.values(os.networkInterfaces())
      .flat()
      .find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;
    if (!ownAddress) return; // no non-loopback interface to test with
    assert.equal(
      resolveBrowserHintForRequest(trustedRequest("lan", ownAddress), "firefox"),
      "firefox"
    );
  });

  test("the trusted verdict wins over a loopback Host header", () => {
    // A remote client that sends a loopback Host must not pass as local.
    assert.equal(
      resolveBrowserHintForRequest(
        trustedRequest("remote", undefined, "localhost:20128"),
        "firefox"
      ),
      "unknown"
    );
  });
});

// Where the sign-in window has to appear. The operator must see it — so it
// opens natively only when their dashboard is open on the OmniRoute host AND
// that host has a display. Otherwise the view is streamed into the dashboard.
describe("resolveSignInMode", () => {
  function trustedRequest(locality: string, peerIp?: string): Request {
    const headers: Record<string, string> = {
      host: "omniroute.example.com",
      "x-omniroute-peer-locality": locality,
    };
    if (peerIp) headers["x-omniroute-trusted-peer-ip"] = peerIp;
    return new Request("http://omniroute.local/api/providers/web-session-login", { headers });
  }

  test("opens a window on the host when the dashboard is open there", () => {
    assert.equal(resolveSignInMode(trustedRequest("loopback"), true), "native");
  });

  test("streams the view when the dashboard is on another machine", () => {
    // The window would open on the host, where the operator cannot see it.
    assert.equal(resolveSignInMode(trustedRequest("lan"), true), "streamed");
    assert.equal(resolveSignInMode(trustedRequest("remote"), true), "streamed");
  });

  test("streams the view when the host has no display", () => {
    // A headless host cannot open a window at all.
    assert.equal(resolveSignInMode(trustedRequest("loopback"), false), "streamed");
  });

  test("recognises a same-machine dashboard reached over the LAN address", () => {
    const ownAddress = Object.values(os.networkInterfaces())
      .flat()
      .find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;
    if (!ownAddress) return; // no non-loopback interface to test with
    assert.equal(resolveSignInMode(trustedRequest("lan", ownAddress), true), "native");
  });

  test("the locality is reported as host or remote", () => {
    assert.equal(resolveDashboardLocality(trustedRequest("loopback")), "host");
    assert.equal(resolveDashboardLocality(trustedRequest("remote")), "remote");
  });
});
