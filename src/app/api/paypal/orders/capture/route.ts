import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { CheckoutError, captureCheckoutOrder } from "@/lib/checkout";
import { PayPalError } from "@/lib/paypal";

export const dynamic = "force-dynamic";

/**
 * POST /api/paypal/orders/capture — the buyer-side completion of the
 * Orders v2 leg: capture a CREATED order (CONCEPT.md §3.2 step 5).
 *
 * Body: { "orderId": "ORDER-…" }. 200 with the capture + reconciler
 * result; an already-captured order is a 200 `alreadyCaptured` no-op;
 * 404 for an unknown order, 409 for a VOIDED one, and an adapter
 * refusal (e.g. sandbox buyer has not approved yet) surfaces with
 * PayPal's own status.
 */
export async function POST(req: Request) {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { store, client } = acquired.runtime;
  let body: { orderId?: string };
  try {
    body = (await req.json()) as { orderId?: string };
  } catch {
    return NextResponse.json({ error: "Request body must be JSON with an 'orderId' string" }, { status: 400 });
  }
  if (!body.orderId) {
    return NextResponse.json({ error: "Missing 'orderId'" }, { status: 400 });
  }
  try {
    const result = await captureCheckoutOrder(client, store, body.orderId);
    return NextResponse.json({
      alreadyCaptured: result.alreadyCaptured,
      order: result.order,
      sync: result.sync
        ? {
            processedEventIds: result.sync.processedEventIds,
            alreadyProcessedEventIds: result.sync.alreadyProcessedEventIds,
            resumedPlans: result.sync.resumed.map((r) => r.plan.id),
          }
        : null,
    });
  } catch (err) {
    if (err instanceof CheckoutError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof PayPalError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
