import { describe, expect, it } from "vitest";
import {
  LedgerStore,
  executePlan,
  handleWebhookEvent,
  parseBrief,
  resumeTriggeredSteps,
  syncFromPayPal,
} from "@/lib/agent";
import { MockPayPalClient, mockTransmissionSig } from "@/lib/paypal";
import type { WebhookEvent } from "@/lib/types";

/**
 * Resource-correlated trigger resumption (hardening, Nov 2–6 window).
 *
 * Before this chunk, resumption matched on event TYPE alone: with two
 * plans awaiting INVOICING.INVOICE.PAID, the first invoice to be paid
 * released BOTH plans' payouts. These tests pin the fix: a gated step
 * is bound at execution time to the invoice its own plan created, and
 * only an event naming that resource can release it.
 */

const NOW = new Date("2026-10-10T12:00:00Z");
const BRIEF_A =
  "Invoice Ana $450 for brand work, due Friday. When it lands, pay $200 to my contractor Marco.";
const BRIEF_B =
  "Invoice Sam $300 for consulting, due tomorrow. When it lands, pay $100 to my contractor Marco.";

async function setupTwoPlans() {
  const store = new LedgerStore();
  const client = new MockPayPalClient();
  const planA = store.addPlan(parseBrief(BRIEF_A, { now: NOW, planId: "plan-a" }));
  const planB = store.addPlan(parseBrief(BRIEF_B, { now: NOW, planId: "plan-b" }));
  store.approvePlan(planA.id);
  store.approvePlan(planB.id);
  const execA = await executePlan(store, client, planA.id);
  const execB = await executePlan(store, client, planB.id);
  const invoiceIdOf = (exec: typeof execA) =>
    exec.plan.steps.find((s) => s.trigger)?.trigger?.resourceId;
  return {
    store,
    client,
    planA,
    planB,
    invoiceA: invoiceIdOf(execA)!,
    invoiceB: invoiceIdOf(execB)!,
  };
}

function signedHeaders(event: WebhookEvent, transmissionId = "trans-0001") {
  return {
    "paypal-transmission-id": transmissionId,
    "paypal-transmission-sig": mockTransmissionSig(transmissionId, event.id),
  };
}

async function payInvoice(client: MockPayPalClient, invoiceId: string, value: string) {
  await client.recordInvoicePayment(invoiceId, { value, currency_code: "USD" });
  return client.emittedEvents.filter((e) => e.event_type === "INVOICING.INVOICE.PAID").at(-1)!;
}

describe("trigger binding at execution time", () => {
  it("binds each plan's gated payout to the invoice that plan created", async () => {
    const { store, client, planA, planB, invoiceA, invoiceB } = await setupTwoPlans();
    expect(invoiceA).toBeTruthy();
    expect(invoiceB).toBeTruthy();
    expect(invoiceA).not.toBe(invoiceB);
    const boundA = store.getPlan(planA.id)!.steps.find((s) => s.trigger)?.trigger?.resourceId;
    const boundB = store.getPlan(planB.id)!.steps.find((s) => s.trigger)?.trigger?.resourceId;
    expect(boundA).toBe(invoiceA);
    expect(boundB).toBe(invoiceB);
    // And the bound ids are real invoices on the adapter, one per plan.
    const invoiceIds = (await client.listInvoices()).map((i) => i.id);
    expect(invoiceIds).toContain(invoiceA);
    expect(invoiceIds).toContain(invoiceB);
  });
});

describe("webhook path: one invoice's payment releases only its own plan", () => {
  it("paying invoice B completes plan B and leaves plan A gated", async () => {
    const { store, client, planA, planB, invoiceB } = await setupTwoPlans();
    const eventB = await payInvoice(client, invoiceB, "300.00");

    const result = await handleWebhookEvent({
      store,
      client,
      headers: signedHeaders(eventB),
      event: eventB,
    });

    expect(result.outcome).toBe("processed");
    expect(result.resumed.map((r) => r.plan.id)).toEqual([planB.id]);
    expect(store.getPlan(planB.id)!.status).toBe("completed");
    expect(store.getPlan(planA.id)!.status).toBe("awaiting_trigger");
    const payouts = await client.listPayouts();
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.items[0]!.payout_item.amount.value).toBe("100.00");
  });

  it("a verified event naming an unknown invoice resumes nothing and is audit-logged", async () => {
    const { store, client, planA, invoiceA } = await setupTwoPlans();
    const realEvent = await payInvoice(client, invoiceA, "450.00");
    const foreignEvent: WebhookEvent = {
      ...realEvent,
      id: "WH-FOREIGN-1",
      summary: "Invoice INV2-999999 was paid",
      resource: { id: "INV2-999999", status: "PAID" },
    };

    const result = await handleWebhookEvent({
      store,
      client,
      headers: signedHeaders(foreignEvent, "trans-foreign"),
      event: foreignEvent,
    });

    expect(result.outcome).toBe("processed");
    expect(result.resumed).toEqual([]);
    expect(store.getPlan(planA.id)!.status).toBe("awaiting_trigger");
    expect(await client.listPayouts()).toHaveLength(0);
    expect(
      store.listActivity().some((a) => a.planId === planA.id && a.summary.includes("does not match")),
    ).toBe(true);

    // The real event afterwards still releases the payout.
    const real = await handleWebhookEvent({
      store,
      client,
      headers: signedHeaders(realEvent, "trans-real"),
      event: realEvent,
    });
    expect(real.resumed.map((r) => r.plan.id)).toEqual([planA.id]);
    expect(store.getPlan(planA.id)!.status).toBe("completed");
    expect(await client.listPayouts()).toHaveLength(1);
  });
});

describe("reconciler path: correlation holds without webhooks", () => {
  it("sync after paying only invoice B resumes only plan B", async () => {
    const { store, client, planA, planB, invoiceB } = await setupTwoPlans();
    await payInvoice(client, invoiceB, "300.00");

    const sync = await syncFromPayPal(store, client);
    expect(sync.resumed.map((r) => r.plan.id)).toEqual([planB.id]);
    expect(store.getPlan(planB.id)!.status).toBe("completed");
    expect(store.getPlan(planA.id)!.status).toBe("awaiting_trigger");
    expect(await client.listPayouts()).toHaveLength(1);
  });

  it("out-of-order payments still close both loops exactly once", async () => {
    const { store, client, planA, planB, invoiceA, invoiceB } = await setupTwoPlans();
    // Pay B before A — delivery/emission order differs from plan order.
    await payInvoice(client, invoiceB, "300.00");
    await payInvoice(client, invoiceA, "450.00");

    const sync = await syncFromPayPal(store, client);
    expect(sync.resumed.map((r) => r.plan.id).sort()).toEqual([planA.id, planB.id]);
    expect(store.getPlan(planA.id)!.status).toBe("completed");
    expect(store.getPlan(planB.id)!.status).toBe("completed");
    const payouts = await client.listPayouts();
    expect(payouts).toHaveLength(2);
    const amounts = payouts.map((p) => p.items[0]!.payout_item.amount.value).sort();
    expect(amounts).toEqual(["100.00", "200.00"]);

    // A second sync is a no-op: no plan re-resumes, no third payout.
    const again = await syncFromPayPal(store, client);
    expect(again.resumed).toEqual([]);
    expect(await client.listPayouts()).toHaveLength(2);
  });
});

describe("executor fallback semantics", () => {
  it("a mismatched resourceId resumes nothing; an id-less call keeps the legacy type-only behavior", async () => {
    const { store, client, planA, invoiceA } = await setupTwoPlans();

    const wrong = await resumeTriggeredSteps(store, client, "INVOICING.INVOICE.PAID", "INV2-000000");
    expect(wrong).toEqual([]);
    expect(store.getPlan(planA.id)!.status).toBe("awaiting_trigger");
    expect(await client.listPayouts()).toHaveLength(0);

    // Id-less callers (direct executor use) keep the pre-hardening
    // type-only semantics: every awaiting plan with a matching trigger
    // resumes. Webhook/reconciler paths always pass a resource id.
    const legacy = await resumeTriggeredSteps(store, client, "INVOICING.INVOICE.PAID");
    expect(legacy.map((r) => r.plan.id).sort()).toEqual([planA.id, "plan-b"]);
    expect(store.getPlan(planA.id)!.status).toBe("completed");
    void invoiceA;
  });
});
