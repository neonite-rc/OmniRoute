import { NextResponse } from "next/server";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { evaluateJevDecisions, type JevRequest } from "@/lib/jev/decisionEngine";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * POST /api/v1/decide — TypeSafe Jev System One Decision Endpoint
 *
 * Accepts context `state` and typed `questions` (choice, score, noul).
 * Returns typed, calibrated decisions in 10-50ms with 0 string-parsing overhead.
 */
export async function POST(request: Request) {
  const policy = await enforceApiKeyPolicy(request, null);
  if (policy.rejection) return policy.rejection;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json", details: ["Invalid JSON body"] },
      { status: 400 }
    );
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json(
      { ok: false, error: "invalid_request", details: ["Body must be an object"] },
      { status: 400 }
    );
  }

  const req = raw as JevRequest;
  if (!req.questions || typeof req.questions !== "object") {
    return NextResponse.json(
      { ok: false, error: "missing_questions", details: ["'questions' object is required"] },
      { status: 400 }
    );
  }

  const result = evaluateJevDecisions(req);
  return NextResponse.json(result, { status: 200 });
}
