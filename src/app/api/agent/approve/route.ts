import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { readJsonObjectBody } from "@/lib/api/body";

/** POST /api/agent/approve — the approval gate. Body: { planId, decision: "approve" | "reject" }. */
export async function POST(req: Request) {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { store } = acquired.runtime;
  const parsed = await readJsonObjectBody(req, "Request body must be JSON");
  if (parsed.response) return parsed.response;
  const { body } = parsed;
  if (typeof body.planId !== "string" || !body.planId || (body.decision !== "approve" && body.decision !== "reject")) {
    return NextResponse.json({ error: "Body must be { planId, decision: 'approve' | 'reject' }" }, { status: 400 });
  }
  try {
    const plan = body.decision === "approve" ? store.approvePlan(body.planId) : store.rejectPlan(body.planId);
    return NextResponse.json({ plan });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
