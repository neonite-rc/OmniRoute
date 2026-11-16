/**
 * POST /api/providers/web-session-login/stream/input
 *
 * Forwards an operator action into the streamed sign-in page.
 *
 * The dashboard draws the streamed frames and sends back what the operator
 * does: a click at a position, a key, a key press, a scroll. The coordinates
 * are in the streamed page's viewport space (1280×800), so the dashboard
 * scales them from whatever size it drew the frame at.
 *
 * Security: management-authenticated like every other management route. It
 * spawns nothing and only touches the page of a session this dashboard
 * started.
 */

import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  applyStreamInput,
  type StreamInput,
} from "@omniroute/open-sse/services/webSessionStreamService.ts";
import { z } from "zod";

const streamInputSchema = z.object({
  sessionId: z.string().min(1).max(128),
  event: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("click"),
      x: z.number().finite().min(-10_000).max(10_000),
      y: z.number().finite().min(-10_000).max(10_000),
    }),
    z.object({
      type: z.literal("key"),
      text: z.string().max(4_000),
    }),
    z.object({
      type: z.literal("press"),
      key: z.string().min(1).max(64),
    }),
    z.object({
      type: z.literal("scroll"),
      deltaX: z.number().finite().min(-10_000).max(10_000),
      deltaY: z.number().finite().min(-10_000).max(10_000),
    }),
  ]),
});

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = streamInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid stream input" }, { status: 400 });
  }

  const { sessionId, event } = parsed.data;
  const applied = await applyStreamInput(sessionId, event as StreamInput);
  return NextResponse.json({ ok: true, applied });
}
