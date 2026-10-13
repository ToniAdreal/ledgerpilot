import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { readJsonObjectBody } from "@/lib/api/body";
import { PlanEditError, editPlanAmounts } from "@/lib/agent";

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
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { store } = acquired.runtime;
  const parsed = await readJsonObjectBody(req, "Request body must be JSON");
  if (parsed.response) return parsed.response;
  const { body } = parsed;
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
