import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { readJsonObjectBody } from "@/lib/api/body";
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
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { store, client } = acquired.runtime;
  const parsed = await readJsonObjectBody(req, "Request body must be JSON with an 'invoiceId' string");
  if (parsed.response) return parsed.response;
  const { body } = parsed;
  const invoiceId = body.invoiceId;
  if (typeof invoiceId !== "string" || !invoiceId) {
    return NextResponse.json({ error: "Missing 'invoiceId'" }, { status: 400 });
  }
  try {
    const result = await recordInvoicePayment(client, store, invoiceId, {
      amount: body.amount === undefined ? undefined : String(body.amount),
      currency_code: body.currency_code === undefined ? undefined : String(body.currency_code),
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
