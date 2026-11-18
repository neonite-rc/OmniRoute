import test, { describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  applyStreamInput,
  attachStreamPage,
  completeStreamedSession,
  createStreamedSession,
  getStreamedSession,
  resetStreamedLogins,
  subscribeToStreamedLogin,
  type StreamEvent,
} from "../../../open-sse/services/webSessionStreamService.ts";

// The streamed sign-in is what puts the sign-in window where the DASHBOARD
// is: the host runs the browser without a display and streams the view into
// the dashboard, which forwards the operator's clicks and keystrokes back.

/** A page that records what the operator did to it. */
function fakePage() {
  const clicks: { x: number; y: number }[] = [];
  const typed: string[] = [];
  const pressed: string[] = [];
  const wheels: { deltaX: number; deltaY: number }[] = [];
  let screenshotCalls = 0;

  const page = {
    async screenshot() {
      screenshotCalls += 1;
      return Buffer.from("fake-jpeg-frame");
    },
    viewportSize() {
      return { width: 1280, height: 800 };
    },
    mouse: {
      async click(x: number, y: number) {
        clicks.push({ x, y });
      },
      async wheel(deltaX: number, deltaY: number) {
        wheels.push({ deltaX, deltaY });
      },
    },
    keyboard: {
      async type(text: string) {
        typed.push(text);
      },
      async press(key: string) {
        pressed.push(key);
      },
    },
  };

  return {
    page: page as unknown as import("playwright").Page,
    clicks,
    typed,
    pressed,
    wheels,
    screenshots: () => screenshotCalls,
  };
}

describe("webSessionStreamService", () => {
  beforeEach(() => {
    resetStreamedLogins();
  });

  afterEach(() => {
    resetStreamedLogins();
  });

  test("a created session is addressable and knows its provider", () => {
    const sessionId = createStreamedSession("gemini-web");
    const session = getStreamedSession(sessionId);
    assert.ok(session);
    assert.equal(session.provider, "gemini-web");
    assert.equal(session.finished, false);
  });

  test("the operator's clicks and keys reach the streamed page", async () => {
    const sessionId = createStreamedSession("gemini-web");
    const fake = fakePage();
    attachStreamPage(sessionId, fake.page);

    assert.equal(await applyStreamInput(sessionId, { type: "click", x: 120, y: 240 }), true);
    assert.equal(await applyStreamInput(sessionId, { type: "key", text: "a" }), true);
    assert.equal(await applyStreamInput(sessionId, { type: "press", key: "Enter" }), true);
    assert.equal(
      await applyStreamInput(sessionId, { type: "scroll", deltaX: 0, deltaY: 120 }),
      true
    );

    assert.deepEqual(fake.clicks, [{ x: 120, y: 240 }]);
    assert.deepEqual(fake.typed, ["a"]);
    assert.deepEqual(fake.pressed, ["Enter"]);
    assert.deepEqual(fake.wheels, [{ deltaX: 0, deltaY: 120 }]);
  });

  test("input for an unknown session is ignored", async () => {
    assert.equal(await applyStreamInput("not-a-session", { type: "click", x: 1, y: 2 }), false);
  });

  test("input is refused once the sign-in finished", async () => {
    const sessionId = createStreamedSession("gemini-web");
    const fake = fakePage();
    attachStreamPage(sessionId, fake.page);
    completeStreamedSession(sessionId, { success: false, error: "Login timed out" });

    assert.equal(await applyStreamInput(sessionId, { type: "click", x: 1, y: 2 }), false);
    assert.equal(fake.clicks.length, 0);
  });

  test("a subscriber receives the captured session", () => {
    const sessionId = createStreamedSession("gemini-web");
    const events: StreamEvent[] = [];
    subscribeToStreamedLogin(sessionId, (event) => events.push(event));

    completeStreamedSession(sessionId, {
      success: true,
      credentials: { session: "abc" },
      cookies: [{ name: "session", value: "abc" }],
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "result");
    assert.equal(events[0].type === "result" && events[0].result.credentials?.session, "abc");
  });

  test("a late subscriber gets the finished result replayed", () => {
    const sessionId = createStreamedSession("gemini-web");
    completeStreamedSession(sessionId, { success: true, credentials: { session: "abc" } });

    const events: StreamEvent[] = [];
    subscribeToStreamedLogin(sessionId, (event) => events.push(event));

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "result");
  });

  test("a failed sign-in is delivered as an error", () => {
    const sessionId = createStreamedSession("gemini-web");
    const events: StreamEvent[] = [];
    subscribeToStreamedLogin(sessionId, (event) => events.push(event));

    completeStreamedSession(sessionId, { success: false, error: "Login timed out" });

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.equal(events[0].type === "error" && events[0].message, "Login timed out");
  });

  test("frames are pushed to subscribers while the page is open", async () => {
    const sessionId = createStreamedSession("gemini-web");
    const fake = fakePage();
    const events: StreamEvent[] = [];
    subscribeToStreamedLogin(sessionId, (event) => events.push(event));

    attachStreamPage(sessionId, fake.page);
    // The frame loop ticks every 400ms — wait for one tick.
    await new Promise((resolve) => setTimeout(resolve, 900));

    const frame = events.find((event) => event.type === "frame");
    assert.ok(frame, "a frame should have been streamed");
    assert.equal(frame.type === "frame" && frame.width, 1280);
    assert.equal(frame.type === "frame" && frame.height, 800);
    assert.equal(
      frame.type === "frame" && Buffer.from(frame.data, "base64").toString(),
      "fake-jpeg-frame"
    );

    completeStreamedSession(sessionId, { success: true, credentials: { session: "abc" } });
    const shotsAtFinish = fake.screenshots();
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(fake.screenshots(), shotsAtFinish, "no frames after the sign-in finished");
  });

  test("a captcha failure carries its error code to the subscriber", async () => {
    // The route needs the code to record the captcha as a persistent problem
    // instead of a generic sign-in failure.
    const sessionId = createStreamedSession("claude-web");
    const events: StreamEvent[] = [];
    subscribeToStreamedLogin(sessionId, (event) => events.push(event));

    completeStreamedSession(sessionId, {
      success: false,
      error: "A Cloudflare challenge is blocking the sign-in.",
      errorCode: "captcha_required",
    });

    const failure = events.find((event) => event.type === "error");
    assert.ok(failure, "the failure is delivered");
    assert.equal(failure.type === "error" && failure.errorCode, "captcha_required");
  });
});
