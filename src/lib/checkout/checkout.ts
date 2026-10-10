/**
 * Checkout capture leg — the buyer-side completion of the Orders v2
 * leg (CONCEPT.md §3.2 step 5: create order → buyer approves in
 * checkout → capture → PAYMENT.CAPTURE.COMPLETED → the order row
 * lands in the console as COMPLETED).
 *
 * Until this module existed, the "sell" side of the loop was a dead
 * end: an approved `create_order` plan step created a CREATED order
 * and nothing in the app could ever capture it — the only captured
 * order in the system was Judge Mode's seeded history, which the
 * seeder captured by calling the adapter directly. This module is
 * the missing buyer step, shaped exactly like Judge Mode's payment
 * leg (`simulateJudgeInvoicePayment`):
 *
 *  - It is NOT an agent action and NOT a plan step. Capturing is what
 *    the *buyer* does by completing checkout; the seller-side agent
 *    never needed a plan approval to receive money, so this path does
 *    not weaken the approval gate (which governs the agent spending /
 *    committing the seller's account). In sandbox mode the real
 *    capture call still only succeeds after the buyer has approved
 *    the order on PayPal's hosted checkout — PayPal enforces that
 *    side; in mock mode there is no buyer, so the capture call itself
 *    stands in for the completed checkout and is labeled as such in
 *    the audit log.
 *  - The capture goes through the adapter, is written to the audit
 *    log as the exact PayPal call, and the resulting
 *    PAYMENT.CAPTURE.COMPLETED event is then processed by the sync
 *    reconciler — the same code path a webhook delivery takes.
 *  - Capturing is idempotent at this layer: an already-COMPLETED
 *    order returns `alreadyCaptured: true` and makes no second
 *    capture call (the adapter would refuse it anyway); a VOIDED
 *    order and an unknown order id are honest errors, never a
 *    silent no-op dressed as success.
 */

import { syncFromPayPal, type SyncResult } from "../agent/reconciler";
import type { LedgerStore } from "../agent/store";
import type { PayPalClient } from "../paypal/client";
import type { Order } from "../types";

export class CheckoutError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

export interface CapturedOrderSummary {
  id: string;
  status: Order["status"];
  captureId: string;
  captureStatus: string;
  amount: string;
  currency_code: string;
}

export interface CaptureCheckoutResult {
  alreadyCaptured: boolean;
  order: CapturedOrderSummary;
  /** Reconciler result for the capture event; null when already captured. */
  sync: SyncResult | null;
}

function summarize(order: Order): CapturedOrderSummary {
  const unit = order.purchase_units[0];
  const capture = unit?.payments?.captures?.[0];
  return {
    id: order.id,
    status: order.status,
    captureId: capture?.id ?? "",
    captureStatus: capture?.status ?? "",
    amount: unit?.amount.value ?? "0.00",
    currency_code: unit?.amount.currency_code ?? "USD",
  };
}

export async function captureCheckoutOrder(
  client: PayPalClient,
  store: LedgerStore,
  orderId: string,
): Promise<CaptureCheckoutResult> {
  const order = (await client.listOrders()).find((o) => o.id === orderId);
  if (!order) {
    throw new CheckoutError(`Order ${orderId} not found — nothing was captured.`, 404);
  }
  if (order.status === "COMPLETED") {
    return { alreadyCaptured: true, order: summarize(order), sync: null };
  }
  if (order.status === "VOIDED") {
    throw new CheckoutError(`Order ${orderId} is VOIDED — a voided order can never be captured.`, 409);
  }

  let captured: Order;
  try {
    captured = await client.captureOrder(orderId);
  } catch (err) {
    // A refused capture (e.g. sandbox: the buyer has not approved the
    // order yet) is part of the audit trail, not a silent failure.
    const message = err instanceof Error ? err.message : String(err);
    store.record({
      kind: "system",
      summary: `Checkout capture for order ${orderId} failed: ${message}`,
      detail: { orderId, captured: false },
    });
    throw err;
  }

  const summary = summarize(captured);
  store.record({
    kind: "paypal_call",
    summary:
      `POST /v2/checkout/orders/${captured.id}/capture → capture ${summary.captureId} ${summary.captureStatus} ` +
      `(${summary.currency_code} ${summary.amount}) — buyer checkout completed`,
    detail: { orderId: captured.id, captureId: summary.captureId, status: captured.status, captured: true },
  });

  // Process the PAYMENT.CAPTURE.COMPLETED event through the reconciler
  // — exactly once, the same code path a webhook delivery takes.
  const sync = await syncFromPayPal(store, client);
  return { alreadyCaptured: false, order: summary, sync };
}
