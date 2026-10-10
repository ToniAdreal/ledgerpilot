import { NextResponse } from "next/server";
import { DraftValidationError, draftOrderPlan, getAgentRuntime } from "@/lib/agent";

export const dynamic = "force-dynamic";

/**
 * POST /api/paypal/orders — thin, validated wrapper over Orders v2
 * (CONCEPT.md §3.1). It drafts a `create_order` action plan and returns
 * it as `pending_approval`; NO order is created until the plan is
 * approved and executed via /api/agent/approve + /api/agent/execute.
 * (Capturing an order the buyer completed lives at
 * POST /api/paypal/orders/capture — buyer-side, not gated.)
 *
 * Body: { description, amount, currency?, reference? } → 201 { plan };
 * 400 on malformed JSON or any validation failure.
 */
export async function POST(req: Request) {
  const { store } = getAgentRuntime();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be JSON order fields" }, { status: 400 });
  }
  try {
    const plan = store.addPlan(draftOrderPlan(body ?? {}));
    return NextResponse.json({ plan }, { status: 201 });
  } catch (err) {
    if (err instanceof DraftValidationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
