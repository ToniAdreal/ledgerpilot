import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { readJsonObjectBody } from "@/lib/api/body";
import { DraftValidationError, draftPayoutPlan } from "@/lib/agent";

export const dynamic = "force-dynamic";

/**
 * POST /api/paypal/payouts — thin, validated wrapper over Payouts
 * (CONCEPT.md §3.1). It drafts a `draft_payout` action plan and returns
 * it as `pending_approval`; NO money moves until the plan is approved
 * and executed via /api/agent/approve + /api/agent/execute. With
 * `payWhenInvoicePaid: "<invoiceId>"` the drafted step is additionally
 * gated on that exact invoice's INVOICING.INVOICE.PAID event.
 *
 * Body (single): { recipientName, amount, currency?, recipientEmail?,
 *         note?, payWhenInvoicePaid? } → 201 { plan }.
 * Body (batch, CONCEPT.md §3.1's batch builder): { items: [{ recipientName,
 *         amount, currency?, recipientEmail?, note? }, …], note?,
 *         payWhenInvoicePaid? } — every line is validated (errors name the
 *         line) and the drafted step executes as ONE Payouts batch.
 * 400 on malformed JSON or any validation failure.
 */
export async function POST(req: Request) {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { store } = acquired.runtime;
  const parsed = await readJsonObjectBody(req, "Request body must be JSON payout fields");
  if (parsed.response) return parsed.response;
  try {
    const plan = store.addPlan(draftPayoutPlan(parsed.body));
    return NextResponse.json({ plan }, { status: 201 });
  } catch (err) {
    if (err instanceof DraftValidationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
