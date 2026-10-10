import { NextResponse } from "next/server";
import { DraftValidationError, draftInvoicePlan, getAgentRuntime } from "@/lib/agent";

export const dynamic = "force-dynamic";

/**
 * POST /api/paypal/invoices — thin, validated wrapper over Invoicing v2
 * (CONCEPT.md §3.1). It drafts a `create_invoice` action plan and
 * returns it as `pending_approval`; NO invoice is created or sent until
 * the plan is approved and executed via /api/agent/approve +
 * /api/agent/execute. The approval gate has no REST back door.
 *
 * Body: { recipientName, amount, description, currency?, dueDate?,
 *         recipientEmail?, note?, reference? } → 201 { plan };
 * 400 on malformed JSON or any validation failure.
 */
export async function POST(req: Request) {
  const { store } = getAgentRuntime();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be JSON invoice fields" }, { status: 400 });
  }
  try {
    const plan = store.addPlan(draftInvoicePlan(body ?? {}));
    return NextResponse.json({ plan }, { status: 201 });
  } catch (err) {
    if (err instanceof DraftValidationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
