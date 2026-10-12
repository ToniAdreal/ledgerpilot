import { NextResponse } from "next/server";
import { getAgentRuntime } from "@/lib/agent";
import { InvoicePaymentError, recordInvoicePayment } from "@/lib/invoice";
import { PayPalError } from "@/lib/paypal";

export const dynamic = "force-dynamic";

/**
 * POST /api/paypal/invoices/record-payment — record a payment made
 * outside PayPal for an open invoice (CONCEPT.md §3.2 step 3).
 *
 * Body: { "invoiceId": "INV2-…", "amount"?: "120.00",
 * "currency_code"?: "USD" }. An omitted amount records the full
 * outstanding amount; an explicit amount records a partial payment.
 * 200 with the recorded payment + reconciler result; an
 * already-paid invoice is a 200 `alreadyPaid` no-op; 404 for an
 * unknown invoice, 409 for a non-open one, 422 for an invalid /
 * over-due / wrong-currency amount, and an adapter refusal surfaces
 * with PayPal's own status. Recording a payment is not an agent
 * action — it needs no plan approval (see src/lib/invoice).
 */
export async function POST(req: Request) {
  const { store, client } = getAgentRuntime();
  let body: { invoiceId?: string; amount?: string; currency_code?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON with an 'invoiceId' string" },
      { status: 400 },
    );
  }
  if (!body.invoiceId) {
    return NextResponse.json({ error: "Missing 'invoiceId'" }, { status: 400 });
  }
  try {
    const result = await recordInvoicePayment(client, store, body.invoiceId, {
      amount: body.amount,
      currency_code: body.currency_code,
    });
    return NextResponse.json({
      alreadyPaid: result.alreadyPaid,
      invoice: result.invoice,
      sync: result.sync
        ? {
            processedEventIds: result.sync.processedEventIds,
            alreadyProcessedEventIds: result.sync.alreadyProcessedEventIds,
            resumedPlans: result.sync.resumed.map((r) => r.plan.id),
          }
        : null,
    });
  } catch (err) {
    if (err instanceof InvoicePaymentError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof PayPalError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
