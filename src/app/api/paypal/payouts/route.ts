import { NextResponse } from "next/server";
import { DraftValidationError, draftPayoutPlan, getAgentRuntime } from "@/lib/agent";

export const dynamic = "force-dynamic";

/**
 * POST /api/paypal/payouts — thin, validated wrapper over Payouts
 * (CONCEPT.md §3.1). It drafts a `draft_payout` action plan and returns
 * it as `pending_approval`; NO money moves until the plan is approved
 * and executed via /api/agent/approve + /api/agent/execute. With
 * `payWhenInvoicePaid: "<invoiceId>"` the drafted step is additionally
 * gated on that exact invoice's INVOICING.INVOICE.PAID event.
 *
 * Body: { recipientName, amount, currency?, recipientEmail?, note?,
 *         payWhenInvoicePaid? } → 201 { plan };
 * 400 on malformed JSON or any validation failure.
 */
export async function POST(req: Request) {
  const { store } = getAgentRuntime();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be JSON payout fields" }, { status: 400 });
  }
  try {
    const plan = store.addPlan(draftPayoutPlan(body ?? {}));
    return NextResponse.json({ plan }, { status: 201 });
  } catch (err) {
    if (err instanceof DraftValidationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
