/**
 * Sync reconciler — the polling fallback for webhooks (CONCEPT.md §3.1).
 *
 * Local instances (and any deployment where PayPal cannot reach the
 * webhook listener) must still close the loop. The reconciler polls the
 * PayPal adapter's current state and processes anything the webhook
 * channel has not already delivered:
 *
 *  1. Undelivered emitted events: adapters that expose an
 *     `emittedEvents` outbox (the mock adapter does; it stands in for
 *     "events PayPal generated but our listener never received") are
 *     drained in order, each event id marked processed exactly once.
 *  2. Resource-state sweep: a PAID invoice / COMPLETED order / SUCCESS
 *     payout batch whose event was never seen synthesizes a stable
 *     `sync:<type>:<resourceId>` event id, so repeat syncs are no-ops.
 *
 * Either path resumes trigger-gated steps through the executor only —
 * the reconciler never calls a mutating PayPal endpoint itself.
 */

import type { PayPalClient } from "../paypal/client";
import type { WebhookEvent, WebhookEventType } from "../types";
import { resumeTriggeredSteps, type ExecutionResult } from "./executor";
import type { LedgerStore } from "./store";

export interface SyncResult {
  checked: { invoices: number; orders: number; payouts: number; emittedEvents: number };
  /** Event ids newly processed by this sync (real or synthetic). */
  processedEventIds: string[];
  /** Event ids skipped because a webhook (or an earlier sync) already processed them. */
  alreadyProcessedEventIds: string[];
  resumed: ExecutionResult[];
  /** Current resource states, so console/API callers can render from one call. */
  state: {
    invoices: Array<{ id: string; status: string }>;
    orders: Array<{ id: string; status: string }>;
    payouts: Array<{ id: string; status: string }>;
  };
}

interface EmittedEventsCarrier {
  emittedEvents?: WebhookEvent[];
}

export async function syncFromPayPal(store: LedgerStore, client: PayPalClient): Promise<SyncResult> {
  const [invoices, orders, payouts] = await Promise.all([
    client.listInvoices(),
    client.listOrders(),
    client.listPayouts(),
  ]);

  const processedEventIds: string[] = [];
  const alreadyProcessedEventIds: string[] = [];
  const resumed: ExecutionResult[] = [];

  const processEvent = async (
    eventId: string,
    eventType: string,
    summary: string,
    source: "emitted" | "state",
    resourceId?: string,
  ) => {
    if (!store.markEventProcessed(eventId)) {
      alreadyProcessedEventIds.push(eventId);
      return;
    }
    processedEventIds.push(eventId);
    store.record({
      kind: "webhook",
      summary: `Sync reconciler processed ${eventType} (${eventId}): ${summary}`,
      detail: { eventId, eventType, source },
    });
    resumed.push(...(await resumeTriggeredSteps(store, client, eventType as WebhookEventType, resourceId)));
  };

  // 1) Drain undelivered emitted events, in emission order.
  const emitted = (client as EmittedEventsCarrier).emittedEvents ?? [];
  for (const event of emitted) {
    const resourceId = typeof event.resource?.id === "string" ? event.resource.id : undefined;
    await processEvent(event.id, event.event_type, event.summary, "emitted", resourceId);
  }

  // 2) Resource-state sweep with stable synthetic ids (idempotent across
  // syncs). Skipped per event type when the adapter's emitted outbox
  // already covers that type — the emitted event is the authoritative
  // record; the sweep is for adapters (sandbox) with no outbox.
  const emittedTypes = new Set(emitted.map((e) => e.event_type));
  for (const inv of invoices) {
    if (inv.status === "PAID" && !emittedTypes.has("INVOICING.INVOICE.PAID")) {
      await processEvent(`sync:INVOICING.INVOICE.PAID:${inv.id}`, "INVOICING.INVOICE.PAID", `Invoice ${inv.id} is PAID`, "state", inv.id);
    }
  }
  for (const order of orders) {
    if (order.status === "COMPLETED" && !emittedTypes.has("PAYMENT.CAPTURE.COMPLETED")) {
      await processEvent(`sync:PAYMENT.CAPTURE.COMPLETED:${order.id}`, "PAYMENT.CAPTURE.COMPLETED", `Order ${order.id} is COMPLETED`, "state", order.id);
    }
  }
  for (const batch of payouts) {
    if (batch.batch_header.batch_status === "SUCCESS" && !emittedTypes.has("PAYMENT.PAYOUTS-ITEM.SUCCEEDED")) {
      const id = batch.batch_header.payout_batch_id;
      await processEvent(`sync:PAYMENT.PAYOUTS-ITEM.SUCCEEDED:${id}`, "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", `Payout batch ${id} is SUCCESS`, "state", id);
    }
  }

  return {
    checked: {
      invoices: invoices.length,
      orders: orders.length,
      payouts: payouts.length,
      emittedEvents: emitted.length,
    },
    processedEventIds,
    alreadyProcessedEventIds,
    resumed,
    state: {
      invoices: invoices.map((i) => ({ id: i.id, status: i.status })),
      orders: orders.map((o) => ({ id: o.id, status: o.status })),
      payouts: payouts.map((p) => ({ id: p.batch_header.payout_batch_id, status: p.batch_header.batch_status })),
    },
  };
}
