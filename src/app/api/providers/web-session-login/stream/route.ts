/**
 * GET /api/providers/web-session-login/stream
 *
 * The live view of a streamed sign-in.
 *
 * When the dashboard is open on another machine, the OmniRoute host runs the
 * browser without a display and streams the view here: a JPEG frame every few
 * hundred milliseconds, plus the status messages and — at the end — the
 * captured session in the very same shape the native sign-in returns.
 *
 * The operator's clicks and keystrokes travel the other way, through
 * `POST /api/providers/web-session-login/stream/input`.
 *
 * Query params:
 *   sessionId — the session returned by the sign-in route
 *
 * Wire format (Server-Sent Events):
 *   event: status  data: { type, message }
 *   event: frame   data: { type, data, width, height }   (data = base64 JPEG)
 *   event: result  data: { type, success, credential, … } (the capture payload)
 *   event: error   data: { type, message }
 *
 * Security: management-authenticated like every other management route. It
 * spawns nothing itself — the browser was started by the sign-in route, which
 * is the LOCAL_ONLY-classified one.
 */

import { NextRequest } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { buildWebSessionCaptureResult } from "@/lib/providers/webSessionCaptureResult";
import { noteCaptchaBlocked } from "@/lib/providers/webSessionCaptureIssues";
import {
  cancelStreamedLogin,
  getStreamedSession,
  subscribeToStreamedLogin,
  type StreamEvent,
} from "@omniroute/open-sse/services/webSessionStreamService.ts";

const HEARTBEAT_MS = 15_000;

export async function GET(request: NextRequest) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (!sessionId) {
    return new Response(JSON.stringify({ error: "sessionId is required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  return createSignInEventStream(sessionId, request);
}

/**
 * Build the Server-Sent Events response for a streamed sign-in.
 *
 * Split out from the route handler so the stream itself can be exercised
 * without the authentication wrapper.
 */
export function createSignInEventStream(sessionId: string, request: Request): Response {
  const encoder = new TextEncoder();

  // Resolved BEFORE subscribing: a subscriber that arrives late gets the
  // final result replayed synchronously, and the handler needs the provider.
  const session = getStreamedSession(sessionId);
  if (!session) {
    return new Response(
      JSON.stringify({
        error: "The sign-in session is no longer available. Start the sign-in again.",
      }),
      { status: 404, headers: { "content-type": "application/json" } }
    );
  }

  // The stream's state lives outside the ReadableStream: the `cancel` handler
  // (the client dropped the stream — the tab was closed) has to release the
  // heartbeat and the subscription as well.
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let finished = false;
  let unsubscribe: () => void = () => {};

  const cleanup = () => {
    finished = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    unsubscribe();
    unsubscribe = () => {};
  };

  const stream = new ReadableStream({
    start(controller) {
      const write = (event: string, data: unknown) => {
        if (finished) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // The client is gone — the abort handler cleans up.
        }
      };

      const finish = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      unsubscribe = subscribeToStreamedLogin(sessionId, (event: StreamEvent) => {
        if (event.type === "result") {
          // The raw extraction map is not a credential — build the canonical
          // payload, exactly like the native sign-in does.
          void buildWebSessionCaptureResult(session.provider, event.result).then(
            (payload) => {
              write("result", payload);
              finish();
            },
            (error: unknown) => {
              write("error", {
                type: "error",
                message: error instanceof Error ? error.message : String(error),
              });
              finish();
            }
          );
          return;
        }
        if (event.type === "error") {
          // A captcha that blocked the streamed sign-in is recorded, so the
          // dashboard can prompt when it keeps coming back.
          if (event.errorCode === "captcha_required") {
            noteCaptchaBlocked(session.provider, event.message);
          }
          write("error", event);
          finish();
          return;
        }
        write(event.type, event);
      }).unsubscribe;

      heartbeat = setInterval(() => {
        if (finished) return;
        try {
          controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
        } catch {
          // The client is gone.
        }
      }, HEARTBEAT_MS);

      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });
    },
    // The client dropped the stream (tab closed, navigation away): stop the
    // heartbeat and the subscription so nothing keeps running on the host.
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Proxies must not buffer the frames — the view has to feel live.
      "x-accel-buffering": "no",
    },
  });
}

/**
 * DELETE /api/providers/web-session-login/stream?sessionId=…
 *
 * Cancels a streamed sign-in. The dashboard calls this when the operator
 * closes the panel, so the host does not keep a browser running until the
 * sign-in times out.
 */
export async function DELETE(request: NextRequest) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (!sessionId) {
    return new Response(JSON.stringify({ error: "sessionId is required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const cancelled = cancelStreamedLogin(sessionId);
  return new Response(JSON.stringify({ cancelled }), {
    status: cancelled ? 200 : 404,
    headers: { "content-type": "application/json" },
  });
}
