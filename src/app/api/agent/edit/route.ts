import { NextResponse } from "next/server";
import { PlanEditError, editPlanAmounts, getAgentRuntime } from "@/lib/agent";

/**
 * POST /api/agent/edit — amend the amounts of a plan still pending
 * approval (CONCEPT.md §3.1's plan-review "Edit"). Body:
 * { planId, edits: [{ stepIndex, amount, currency? }] } — a batch
 * payout step is amended per line via
 * { stepIndex, items: [{ index, amount, currency? }] }.
 *
 * The amendment is gate-preserving by construction: it only rewrites
 * a pending plan's steps (exactly like drafting), validates every
 * amount through the drafts module's money rules, regenerates the
 * step descriptions approval will cover, and writes the change to
 * the audit log. An approved plan cannot be amended — approval
 * always covers exactly the steps the reviewer saw. Nothing executes
 * on this surface.
 */
export async function POST(req: Request) {
  const { store } = getAgentRuntime();
  let body: { planId?: string; edits?: unknown };
  try {
    body = (await req.json()) as { planId?: string; edits?: unknown };
  } catch {
    return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 });
  }
  if (!body.planId || typeof body.planId !== "string") {
    return NextResponse.json({ error: "Body must be { planId, edits: [...] }" }, { status: 400 });
  }
  try {
    const plan = editPlanAmounts(store, body.planId, { edits: body.edits });
    return NextResponse.json({ plan });
  } catch (err) {
    if (err instanceof PlanEditError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
