import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { readJsonObjectBody } from "@/lib/api/body";
import { executePlan } from "@/lib/agent";

/** POST /api/agent/execute — runs an approved plan. Body: { planId }. Unapproved plans are refused. */
export async function POST(req: Request) {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { store, client } = acquired.runtime;
  const parsed = await readJsonObjectBody(req, "Request body must be JSON");
  if (parsed.response) return parsed.response;
  const { body } = parsed;
  if (typeof body.planId !== "string" || !body.planId) {
    return NextResponse.json({ error: "Missing 'planId'" }, { status: 400 });
  }
  try {
    const result = await executePlan(store, client, body.planId);
    return NextResponse.json({ plan: result.plan, outcomes: result.outcomes.map((o) => ({ type: o.step.type, outcome: o.outcome, resultId: o.resultId, error: o.error })) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
