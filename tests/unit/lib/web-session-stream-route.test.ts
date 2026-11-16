import test, { describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import * as dbCore from "../../../src/lib/db/core.ts";
import {
  attachStreamPage,
  completeStreamedSession,
  createStreamedSession,
  resetStreamedLogins,
} from "../../../open-sse/services/webSessionStreamService.ts";
import { createSignInEventStream } from "../../../src/app/api/providers/web-session-login/stream/route.ts";

// The streamed sign-in delivers the sign-in window into the dashboard: the
// host streams frames of the login page and the captured session when the
// operator is done.

function fakePage() {
  return {
    async screenshot() {
      return Buffer.from("fake-jpeg-frame");
    },
    viewportSize() {
      return { width: 1280, height: 800 };
    },
    mouse: { async click() {}, async wheel() {} },
    keyboard: { async type() {}, async press() {} },
  } as unknown as import("playwright").Page;
}

async function readEvents(response: Response, count: number): Promise<string[]> {
  const reader = response.body?.getReader();
  assert.ok(reader, "the stream must have a body");
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let buffered = "";
  while (chunks.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const parts = buffered.split("\n\n");
    buffered = parts.pop() ?? "";
    for (const part of parts) {
      if (part.includes("event:")) chunks.push(part);
    }
  }
  await reader.cancel().catch(() => {});
  return chunks;
}

/** A request whose signal can be aborted to release the stream. */
function streamRequest(controller: AbortController): Request {
  return new Request("http://omniroute.local/api/providers/web-session-login/stream", {
    signal: controller.signal,
  });
}

describe("the streamed sign-in event stream", () => {
  let abortController: AbortController | null = null;

  beforeEach(() => {
    resetStreamedLogins();
    abortController = new AbortController();
  });

  afterEach(() => {
    // Release the stream so the heartbeat does not keep the process alive.
    abortController?.abort();
    abortController = null;
    resetStreamedLogins();
    // The route pulls in the management-auth modules, which open the local
    // SQLite handle — release it so the test runner can exit.
    dbCore.resetDbInstance();
  });

  test("pushes frames of the sign-in page to the dashboard", async () => {
    const sessionId = createStreamedSession("gemini-web");
    attachStreamPage(sessionId, fakePage());

    const response = createSignInEventStream(sessionId, streamRequest(abortController!));
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(response.headers.get("x-accel-buffering"), "no");

    const events = await readEvents(response, 1);
    assert.equal(events.length, 1);
    assert.ok(events[0].startsWith("event: frame"), events[0]);
    // The frame carries the screenshot as base64 JPEG.
    assert.ok(events[0].includes(Buffer.from("fake-jpeg-frame").toString("base64")), events[0]);
  });

  test("delivers the captured session when the sign-in finishes", async () => {
    const sessionId = createStreamedSession("claude-web");

    const response = createSignInEventStream(sessionId, streamRequest(abortController!));

    // Complete the sign-in once the stream is attached.
    setTimeout(() => {
      completeStreamedSession(sessionId, {
        success: true,
        credentials: { sessionKey: "abc" },
        cookies: [{ name: "sessionKey", value: "abc" }],
      });
    }, 50);

    const events = await readEvents(response, 1);
    assert.equal(events.length, 1);
    assert.ok(events[0].startsWith("event: result"), events[0]);
    // The payload is the canonical credential — not the raw cookie map.
    assert.ok(events[0].includes('"success":true'), events[0]);
    assert.ok(events[0].includes("sessionKey=abc"), events[0]);
  });

  test("answers 404 for a session that is gone", async () => {
    const response = createSignInEventStream("not-a-session", streamRequest(abortController!));
    assert.equal(response.status, 404);
  });
});
