/**
 * Streamed web-session sign-in — the sign-in window that opens where the
 * DASHBOARD is, not where the OmniRoute host is.
 *
 * The problem this solves: the browser session has to live on the OmniRoute
 * host (that is where the captured cookie is stored and used), but the
 * operator may be sitting at another machine — the common setup is a
 * headless server on the LAN with the dashboard open in a laptop browser. A
 * window opened on the host would be invisible to them, and on a headless
 * host it cannot open at all.
 *
 * So the host runs the browser WITHOUT a display and streams the view into
 * the dashboard, which draws it and forwards the operator's clicks and
 * keystrokes back to the page. The operator signs in on their own screen,
 * exactly like the native flow, and the capture is unchanged: the same
 * Playwright page, the same persistent profile, the same credential contract.
 *
 * This is deliberately dependency-free: no X server, no VNC daemon, no Docker
 * image. It only needs the Playwright browser build the host already manages.
 *
 * Events delivered to subscribers:
 *   { type: "status", message }                  — human-readable progress
 *   { type: "frame", data, width, height }       — a JPEG screenshot (base64)
 *   { type: "result", result }                   — the captured session
 *   { type: "error", message, errorCode? }       — the sign-in failed
 */

import { randomUUID } from "node:crypto";

import { inAppLoginService, type LoginResult } from "./inAppLoginService";
import type { BrowserFamily } from "@/shared/providers/browserFamily";

// ─── Types ───────────────────────────────────────────────────────────────────

/** One operator action forwarded from the dashboard into the streamed page. */
export type StreamInput =
  | { type: "click"; x: number; y: number }
  | { type: "key"; text: string }
  | { type: "press"; key: string }
  | { type: "scroll"; deltaX: number; deltaY: number };

export type StreamEvent =
  | { type: "status"; message: string }
  | { type: "frame"; data: string; width: number; height: number }
  | { type: "result"; result: LoginResult }
  | { type: "error"; message: string; errorCode?: string };

export type StreamListener = (event: StreamEvent) => void;

/** How often a frame is captured and pushed to the dashboard. */
const FRAME_INTERVAL_MS = 400;
/** JPEG quality of a streamed frame (low enough to stream over a LAN). */
const FRAME_QUALITY = 45;
/** How long a finished session is kept so a late subscriber still gets it. */
const SESSION_GRACE_MS = 60_000;
/** The viewport the streamed page is rendered in (matches the native flow). */
export const STREAM_VIEWPORT = { width: 1280, height: 800 } as const;

interface StreamedSession {
  sessionId: string;
  provider: string;
  page: import("playwright").Page | null;
  listeners: Set<StreamListener>;
  result: LoginResult | null;
  error: string | null;
  frameTimer: NodeJS.Timeout | null;
  captureInFlight: boolean;
  finished: boolean;
  createdAt: number;
}

const SESSIONS = new Map<string, StreamedSession>();

// ─── Session lifecycle ───────────────────────────────────────────────────────

/**
 * Create a streamed session without starting the browser yet.
 *
 * The browser is attached later (see `attachStreamPage`), which is what the
 * login flow does once Playwright has the page.
 */
export function createStreamedSession(provider: string): string {
  const sessionId = randomUUID();
  SESSIONS.set(sessionId, {
    sessionId,
    provider,
    page: null,
    listeners: new Set(),
    result: null,
    error: null,
    frameTimer: null,
    captureInFlight: false,
    finished: false,
    createdAt: Date.now(),
  });
  return sessionId;
}

/**
 * Attach the live login page to a session and start streaming frames.
 */
export function attachStreamPage(sessionId: string, page: import("playwright").Page): void {
  const session = SESSIONS.get(sessionId);
  if (!session) return;
  session.page = page;
  startFrameLoop(session);
}

/**
 * Finish a session: the captured session (or the failure) is delivered to
 * every subscriber, and a late subscriber gets it replayed.
 */
export function completeStreamedSession(sessionId: string, result: LoginResult): void {
  const session = SESSIONS.get(sessionId);
  if (!session) return;
  session.result = result;
  session.finished = true;
  stopFrameLoop(session);
  if (result.success) {
    emit(session, { type: "result", result });
  } else {
    session.error = result.error || "Sign-in did not complete";
    // The error code travels with the event so the route can tell a captcha
    // block from any other failure and record it as a persistent problem.
    emit(session, {
      type: "error",
      message: session.error,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    });
  }
  scheduleCleanup(session);
}

/**
 * Start a streamed sign-in.
 *
 * Returns as soon as the session exists — the browser starts in the
 * background and the dashboard subscribes to the event stream. The captured
 * session arrives as a `result` event.
 */
export async function startStreamedLogin(
  provider: string,
  options: {
    timeout?: number;
    browser?: BrowserFamily;
    /**
     * Called once the sign-in finished, before the result is delivered.
     *
     * The re-sync path uses it to store the capture straight onto the
     * connection — the credential never has to travel through the browser. A
     * failure here replaces the result with that failure, so the operator
     * sees why the session was not stored.
     */
    onComplete?: (result: LoginResult) => Promise<void>;
  }
): Promise<{ sessionId: string }> {
  const sessionId = createStreamedSession(provider);

  // The login runs in the background: the route returns the session id right
  // away and the dashboard follows the event stream.
  void inAppLoginService
    .startLogin(provider, {
      timeout: options.timeout,
      browser: options.browser,
      // No display on the host — the view is streamed to the operator.
      headless: true,
      onPage: (page) => {
        attachStreamPage(sessionId, page);
      },
    })
    .then(async (result) => {
      let finalResult = result;
      if (options.onComplete) {
        try {
          await options.onComplete(result);
        } catch (error: unknown) {
          finalResult = {
            success: false,
            error:
              error instanceof Error ? error.message : "The captured session could not be stored.",
          };
        }
      }
      completeStreamedSession(sessionId, finalResult);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const session = SESSIONS.get(sessionId);
      if (session) {
        session.error = message;
        session.finished = true;
        stopFrameLoop(session);
        emit(session, { type: "error", message });
        scheduleCleanup(session);
      }
    });

  return { sessionId };
}

/** The streamed session, if it still exists. */
export function getStreamedSession(sessionId: string): StreamedSession | undefined {
  return SESSIONS.get(sessionId);
}

/**
 * Subscribe to a streamed session.
 *
 * A late subscriber immediately receives the final result when the sign-in
 * already finished — the dashboard may connect a moment after the capture.
 */
export function subscribeToStreamedLogin(
  sessionId: string,
  listener: StreamListener
): { unsubscribe: () => void; session: StreamedSession | null } {
  const session = SESSIONS.get(sessionId);
  if (!session) return { unsubscribe: () => {}, session: null };

  session.listeners.add(listener);

  if (session.finished) {
    if (session.result?.success) {
      listener({ type: "result", result: session.result });
    } else if (session.error) {
      listener({ type: "error", message: session.error });
    }
  }

  return {
    unsubscribe: () => {
      session.listeners.delete(listener);
    },
    session,
  };
}

/**
 * Forward an operator action into the streamed page.
 *
 * @returns true when the action was applied.
 */
export async function applyStreamInput(sessionId: string, input: StreamInput): Promise<boolean> {
  const session = SESSIONS.get(sessionId);
  const page = session?.page;
  if (!session || !page || session.finished) return false;

  try {
    switch (input.type) {
      case "click":
        await page.mouse.click(input.x, input.y);
        return true;
      case "key":
        await page.keyboard.type(input.text);
        return true;
      case "press":
        await page.keyboard.press(input.key);
        return true;
      case "scroll":
        await page.mouse.wheel(input.deltaX, input.deltaY);
        return true;
      default:
        return false;
    }
  } catch {
    // A page that navigated away rejects the action — the next frame shows
    // where the browser actually is, so dropping the action is enough.
    return false;
  }
}

/** Cancel a streamed sign-in (the operator closed the panel). */
export function cancelStreamedLogin(sessionId: string): boolean {
  const session = SESSIONS.get(sessionId);
  if (!session) return false;
  session.finished = true;
  stopFrameLoop(session);
  emit(session, { type: "error", message: "Sign-in cancelled" });
  scheduleCleanup(session);
  return true;
}

/** Drop every finished session (used by tests and on server shutdown). */
export function resetStreamedLogins(): void {
  for (const session of SESSIONS.values()) {
    stopFrameLoop(session);
  }
  SESSIONS.clear();
}

// ─── Internals ───────────────────────────────────────────────────────────────

function emit(session: StreamedSession, event: StreamEvent): void {
  for (const listener of [...session.listeners]) {
    try {
      listener(event);
    } catch {
      // A broken subscriber must not stop the others.
    }
  }
}

function startFrameLoop(session: StreamedSession): void {
  if (session.frameTimer || session.finished) return;
  session.frameTimer = setInterval(() => {
    void captureFrame(session);
  }, FRAME_INTERVAL_MS);
  session.frameTimer.unref?.();
}

function stopFrameLoop(session: StreamedSession): void {
  if (!session.frameTimer) return;
  clearInterval(session.frameTimer);
  session.frameTimer = null;
}

async function captureFrame(session: StreamedSession): Promise<void> {
  const page = session.page;
  if (!page || session.finished || session.captureInFlight) return;
  session.captureInFlight = true;
  try {
    const buffer = await page.screenshot({
      type: "jpeg",
      quality: FRAME_QUALITY,
      timeout: 5_000,
    });
    const viewport = page.viewportSize() ?? STREAM_VIEWPORT;
    emit(session, {
      type: "frame",
      data: Buffer.from(buffer).toString("base64"),
      width: viewport.width,
      height: viewport.height,
    });
  } catch {
    // The page may be closed or navigating — the next tick tries again.
  } finally {
    session.captureInFlight = false;
  }
}

function scheduleCleanup(session: StreamedSession): void {
  const timer = setTimeout(() => {
    SESSIONS.delete(session.sessionId);
  }, SESSION_GRACE_MS);
  timer.unref?.();
}
