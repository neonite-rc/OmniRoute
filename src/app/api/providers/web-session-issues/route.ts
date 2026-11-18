/**
 * GET  /api/providers/web-session-issues — the problems that need a prompt.
 * POST /api/providers/web-session-issues — dismiss a prompt.
 *
 * A web-session provider can go bad in a way the provider list does not show:
 * the saved session expires, or a captcha / anti-bot challenge stands in front
 * of the sign-in. Those problems are tracked server-side (see
 * `src/lib/providers/webSessionIssues.ts`) and surfaced HERE, so the dashboard
 * can raise exactly one prompt per problem episode:
 *
 *   - the prompt fires when the problem persists, not on every attempt,
 *   - a solved problem disappears from this list,
 *   - a removed provider's problems are deleted and never show again.
 *
 * The POST acknowledges a prompt the operator dismissed. Acknowledging stops
 * the prompt for the current episode; a problem that comes back later opens a
 * new episode and may prompt again.
 *
 * The route only reads and acknowledges bookkeeping rows — it launches
 * nothing and spawns no process, so it is not LOCAL_ONLY.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  acknowledgeWebSessionIssueAlert,
  listWebSessionIssueAlerts,
} from "@/lib/providers/webSessionIssues";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

const acknowledgeSchema = z.object({
  id: z.string().trim().min(1),
});

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const alerts = listWebSessionIssueAlerts();
    return NextResponse.json({
      object: "list",
      data: alerts.map((alert) => ({
        id: alert.id,
        providerId: alert.providerId,
        kind: alert.kind,
        title: alert.title,
        message: alert.message,
        occurrences: alert.occurrences,
        firstSeenAt: alert.firstSeenAt,
        lastSeenAt: alert.lastSeenAt,
        detail: alert.detail,
      })),
    });
  } catch (error) {
    // Hard Rule #12: never ship a raw error message.
    return NextResponse.json(
      { error: sanitizeErrorMessage(error) || "Failed to read web-session issues" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = acknowledgeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    acknowledgeWebSessionIssueAlert(parsed.data.id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: sanitizeErrorMessage(error) || "Failed to acknowledge web-session issue" },
      { status: 500 }
    );
  }
}
