#!/usr/bin/env node
/**
 * Live check: the streamed web-session sign-in.
 *
 * The dashboard can be open on another machine — then a browser window on the
 * OmniRoute host would be invisible to the operator, so the host runs the
 * browser headless and streams the login page into the dashboard tab.
 *
 * This script drives the REAL route handlers against the REAL browser:
 *   1. POST /api/providers/web-session-login with the trusted locality verdict
 *      of a remote dashboard → the route must answer { mode: "stream" }.
 *   2. The streamed session must deliver frames (a JPEG of the login page).
 *   3. POST /api/providers/web-session-login/stream/input must apply a click
 *      to the page.
 *   4. The session must be cancellable.
 *
 * One-shot helper for the web-session auto-capture change; kept under
 * scripts/ad-hoc/ per the repo's file-placement rules.
 *
 * Run: node --import tsx scripts/ad-hoc/web-session-stream-live-check.ts
 */

import { AUTHZ_HEADER_PEER_LOCALITY } from "../../src/server/authz/headers.ts";

/**
 * The base URL the synthetic requests carry.
 *
 * It is only the URL of the `Request` objects — the route handlers are called
 * in-process — so it does not have to be reachable. It points at the dev
 * server by default so the log lines look like the real ones.
 */
const BASE = process.env.OMNIROUTE_TEST_BASE_URL ?? "http://127.0.0.1:20128";

/**
 * A manage-scoped API key. The request below looks like it came from another
 * machine, so the management guard asks for a credential (a loopback caller
 * would not).
 */
const MANAGEMENT_KEY = process.env.OMNIROUTE_TEST_MANAGEMENT_KEY ?? "";
if (!MANAGEMENT_KEY) {
  console.error(
    "FAIL: set OMNIROUTE_TEST_MANAGEMENT_KEY to a manage-scoped API key before running this."
  );
  process.exit(1);
}

/** The headers every request in this check carries. */
function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${MANAGEMENT_KEY}`,
    ...extra,
  };
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

// ── 1. The route answers with a streamed session ─────────────────────────────

const loginRoute = await import("../../src/app/api/providers/web-session-login/route.ts");

const loginResponse = await loginRoute.POST(
  new Request(`${BASE}/api/providers/web-session-login`, {
    method: "POST",
    headers: headers({
      // The trusted locality verdict the authz pipeline stamps on every
      // request: this one came from another machine.
      [AUTHZ_HEADER_PEER_LOCALITY]: "remote",
    }),
    body: JSON.stringify({ provider: "gemini-web", browser: "firefox" }),
  })
);

const loginBody = (await loginResponse.json()) as {
  success?: boolean;
  mode?: string;
  sessionId?: string;
  error?: string;
};

console.log("POST /api/providers/web-session-login →", JSON.stringify(loginBody));
if (!loginBody.success || loginBody.mode !== "stream" || !loginBody.sessionId) {
  fail(`expected a streamed session, got ${JSON.stringify(loginBody)}`);
}
const sessionId = loginBody.sessionId;

// ── 2. Frames arrive ─────────────────────────────────────────────────────────

const streamRoute = await import("../../src/app/api/providers/web-session-login/stream/route.ts");

const controller = new AbortController();
const streamResponse = await streamRoute.GET(
  new Request(`${BASE}/api/providers/web-session-login/stream?sessionId=${sessionId}`, {
    signal: controller.signal,
    headers: headers(),
  })
);

if (streamResponse.status !== 200) {
  fail(`the event stream answered ${streamResponse.status}`);
}

const reader = streamResponse.body?.getReader();
if (!reader) fail("the event stream has no body");

const decoder = new TextDecoder();
let buffered = "";
let frameBytes = 0;
const deadline = Date.now() + 60_000;

outer: while (Date.now() < deadline) {
  const { value, done } = await reader.read();
  if (done) break;
  buffered += decoder.decode(value, { stream: true });
  const parts = buffered.split("\n\n");
  buffered = parts.pop() ?? "";
  for (const part of parts) {
    if (!part.startsWith("event: frame")) continue;
    const dataLine = part.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) continue;
    const payload = JSON.parse(dataLine.slice("data: ".length)) as {
      data: string;
      width: number;
      height: number;
    };
    frameBytes = Buffer.from(payload.data, "base64").length;
    console.log(`frame: ${frameBytes} bytes of JPEG, ${payload.width}x${payload.height}`);
    break outer;
  }
}

if (!frameBytes) fail("no frame arrived within 60s");

// ── 3. Input reaches the page ────────────────────────────────────────────────

const inputRoute =
  await import("../../src/app/api/providers/web-session-login/stream/input/route.ts");

const inputResponse = await inputRoute.POST(
  new Request(`${BASE}/api/providers/web-session-login/stream/input`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      sessionId,
      event: { type: "click", x: 120, y: 80 },
    }),
  })
);

const inputBody = (await inputResponse.json()) as { applied?: boolean; error?: string };
console.log("POST /api/providers/web-session-login/stream/input →", JSON.stringify(inputBody));
if (inputResponse.status !== 200 || inputBody.applied !== true) {
  fail(`the input was not applied: ${JSON.stringify(inputBody)}`);
}

// ── 4. The session can be cancelled ──────────────────────────────────────────

const cancelResponse = await streamRoute.DELETE(
  new Request(`${BASE}/api/providers/web-session-login/stream?sessionId=${sessionId}`, {
    method: "DELETE",
    headers: headers(),
  })
);
console.log("DELETE stream →", cancelResponse.status);
if (cancelResponse.status !== 200) fail(`the cancel answered ${cancelResponse.status}`);

controller.abort();
console.log("OK — the streamed sign-in delivers frames, takes input and cancels.");
process.exit(0);
