import { describe, expect, it } from "vitest";
import {
  LedgerStore,
  executePlan,
  handleWebhookEvent,
  parseBrief,
  syncFromPayPal,
} from "@/lib/agent";
import { MockPayPalClient, mockTransmissionSig } from "@/lib/paypal";
import type { WebhookEvent } from "@/lib/types";

const NOW = new Date("2026-10-10T12:00:00Z");
const DEMO_BRIEF =
  "Invoice Ana $450 for brand work, due Friday. When it lands, pay $200 to my contractor Marco.";

/** Set up a plan whose payout is deferred, awaiting INVOICING.INVOICE.PAID. */
async function setupAwaitingPayout() {
  const store = new LedgerStore();
  const client = new MockPayPalClient();
  const plan = store.addPlan(parseBrief(DEMO_BRIEF, { now: NOW, planId: "plan-wh-1" }));
  store.approvePlan(plan.id);
  await executePlan(store, client, plan.id);
  const [invoice] = await client.listInvoices();
  await client.recordInvoicePayment(invoice!.id, { value: "450.00", currency_code: "USD" });
  const event = client.emittedEvents.find((e) => e.event_type === "INVOICING.INVOICE.PAID")!;
  return { store, client, plan, invoice: invoice!, event };
}

function signedHeaders(event: WebhookEvent, transmissionId = "trans-0001") {
  return {
    "paypal-transmission-id": transmissionId,
    "paypal-transmission-sig": mockTransmissionSig(transmissionId, event.id),
  };
}

describe("webhook handler", () => {
  it("verifies, records, and resumes the gated payout on INVOICING.INVOICE.PAID", async () => {
    const { store, client, plan, event } = await setupAwaitingPayout();
    const result = await handleWebhookEvent({ store, client, headers: signedHeaders(event), event });
    expect(result.outcome).toBe("processed");
    expect(result.resumed.map((r) => r.plan.id)).toEqual([plan.id]);
    expect(store.getPlan(plan.id)!.status).toBe("completed");
    expect(await client.listPayouts()).toHaveLength(1);
    const webhookRows = store.listActivity().filter((a) => a.kind === "webhook");
    expect(webhookRows.some((a) => a.summary.includes("verified"))).toBe(true);
  });

  it("rejects a bad signature: no resume, no payout, event not marked processed", async () => {
    const { store, client, plan, event } = await setupAwaitingPayout();
    const result = await handleWebhookEvent({
      store,
      client,
      headers: { "paypal-transmission-id": "trans-x", "paypal-transmission-sig": "deadbeef" },
      event,
    });
    expect(result.outcome).toBe("rejected_signature");
    expect(store.hasProcessedEvent(event.id)).toBe(false);
    expect(store.getPlan(plan.id)!.status).toBe("awaiting_trigger");
    expect(await client.listPayouts()).toHaveLength(0);
    // A later, correctly-signed delivery of the same event still works.
    const retry = await handleWebhookEvent({ store, client, headers: signedHeaders(event), event });
    expect(retry.outcome).toBe("processed");
    expect(await client.listPayouts()).toHaveLength(1);
  });

  it("treats a redelivery as a duplicate — the payout happens exactly once", async () => {
    const { store, client, event } = await setupAwaitingPayout();
    const headers = signedHeaders(event);
    const first = await handleWebhookEvent({ store, client, headers, event });
    const second = await handleWebhookEvent({ store, client, headers, event });
    expect(first.outcome).toBe("processed");
    expect(second.outcome).toBe("duplicate");
    expect(second.resumed).toHaveLength(0);
    expect(await client.listPayouts()).toHaveLength(1);
  });

  it("accepts a verified unrelated event without resuming anything", async () => {
    const { store, client, plan } = await setupAwaitingPayout();
    const unrelated: WebhookEvent = {
      id: "WH-UNRELATED-1",
      create_time: new Date().toISOString(),
      resource_type: "capture",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      summary: "A capture completed elsewhere",
      resource: { id: "CAP-OTHER" },
      event_version: "1.0",
      resource_version: "2.0",
    };
    const result = await handleWebhookEvent({ store, client, headers: signedHeaders(unrelated), event: unrelated });
    expect(result.outcome).toBe("processed");
    expect(result.resumed).toHaveLength(0);
    expect(store.getPlan(plan.id)!.status).toBe("awaiting_trigger");
  });
});

describe("sync reconciler", () => {
  it("closes the loop without any webhook delivery, and is idempotent on repeat calls", async () => {
    const { store, client, plan, event } = await setupAwaitingPayout();
    const first = await syncFromPayPal(store, client);
    expect(first.processedEventIds).toContain(event.id);
    expect(first.resumed.map((r) => r.plan.id)).toEqual([plan.id]);
    expect(store.getPlan(plan.id)!.status).toBe("completed");
    expect(await client.listPayouts()).toHaveLength(1);
    expect(first.state.invoices).toEqual([{ id: expect.any(String), status: "PAID" }]);

    const second = await syncFromPayPal(store, client);
    expect(second.processedEventIds).toHaveLength(0);
    expect(second.alreadyProcessedEventIds).toContain(event.id);
    expect(second.resumed).toHaveLength(0);
    expect(await client.listPayouts()).toHaveLength(1); // still exactly one payout
  });

  it("does not re-process an event already delivered via webhook", async () => {
    const { store, client, event } = await setupAwaitingPayout();
    await handleWebhookEvent({ store, client, headers: signedHeaders(event), event });
    const sync = await syncFromPayPal(store, client);
    expect(sync.processedEventIds).not.toContain(event.id);
    expect(sync.alreadyProcessedEventIds).toContain(event.id);
    expect(await client.listPayouts()).toHaveLength(1);
  });

  it("is a no-op when nothing has happened yet", async () => {
    const store = new LedgerStore();
    const client = new MockPayPalClient();
    const sync = await syncFromPayPal(store, client);
    expect(sync.checked).toEqual({ invoices: 0, orders: 0, payouts: 0, emittedEvents: 0 });
    expect(sync.processedEventIds).toHaveLength(0);
    expect(sync.resumed).toHaveLength(0);
  });
});
