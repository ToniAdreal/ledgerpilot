import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { readJsonObjectBody } from "@/lib/api/body";
import { DraftValidationError, draftInvoicePlan } from "@/lib/agent";

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
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { store } = acquired.runtime;
  const parsed = await readJsonObjectBody(req, "Request body must be JSON invoice fields");
  if (parsed.response) return parsed.response;
  try {
    const plan = store.addPlan(draftInvoicePlan(parsed.body));
    return NextResponse.json({ plan }, { status: 201 });
  } catch (err) {
    if (err instanceof DraftValidationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
