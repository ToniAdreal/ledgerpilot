import { NextResponse } from "next/server";
import { executePlan, getAgentRuntime } from "@/lib/agent";

/** POST /api/agent/execute — runs an approved plan. Body: { planId }. Unapproved plans are refused. */
export async function POST(req: Request) {
  const { store, client } = getAgentRuntime();
  let body: { planId?: string };
  try {
    body = (await req.json()) as { planId?: string };
  } catch {
    return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 });
  }
  if (!body.planId) {
    return NextResponse.json({ error: "Missing 'planId'" }, { status: 400 });
  }
  try {
    const result = await executePlan(store, client, body.planId);
    return NextResponse.json({ plan: result.plan, outcomes: result.outcomes.map((o) => ({ type: o.step.type, outcome: o.outcome, resultId: o.resultId, error: o.error })) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
