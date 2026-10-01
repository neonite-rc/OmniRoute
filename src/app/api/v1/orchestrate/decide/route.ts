import { NextResponse } from "next/server";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { decideAgentTask } from "@/lib/jev/decisionEngine";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * POST /api/v1/orchestrate/decide — Instant Agent Dilemma Resolver
 *
 * Designed for autonomous AI agents (e.g. Hermes Agent, Cursor, Claude Code)
 * that need to immediately resolve whether to answer a prompt directly (SELF),
 * delegate to a specialist (DELEGATE), or spawn a parallel multi-model swarm (SWARM).
 *
 * Input:
 *   { "task": "refactor database connection and run unit tests across 4 models" }
 *
 * Output:
 *   {
 *     "ok": true,
 *     "action": "SWARM",
 *     "should_use_omniroute": true,
 *     "confidence": 0.94,
 *     "tag": "code",
 *     "recommended_model": "kr/qwen3-coder-next",
 *     "execution_command": "omni-swarm(goal=..., subtasks=[...])",
 *     "reason": "System-1 evaluated SWARM (confidence: 94%, domain: code)",
 *     "latency_ms": 12.4
 *   }
 */
export async function POST(request: Request) {
  const policy = await enforceApiKeyPolicy(request, null);
  if (policy.rejection) return policy.rejection;

  let raw: any;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json", details: ["Invalid JSON body"] },
      { status: 400 }
    );
  }

  const task = typeof raw?.task === "string" ? raw.task : (typeof raw?.prompt === "string" ? raw.prompt : "");
  if (!task) {
    return NextResponse.json(
      { ok: false, error: "missing_task", details: ["'task' or 'prompt' string is required"] },
      { status: 400 }
    );
  }

  const decision = decideAgentTask(task);
  return NextResponse.json({ ok: true, ...decision }, { status: 200 });
}
