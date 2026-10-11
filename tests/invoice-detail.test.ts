import { describe, expect, it } from "vitest";
import {
  LedgerStore,
  draftPayoutPlan,
  executePlan,
  handleWebhookEvent,
  parseBrief,
  syncFromPayPal,
} from "@/lib/agent";
import { buildInvoiceDetail, recordConcernsInvoice } from "@/lib/console/invoice-detail";
import { seedJudgeScenario } from "@/lib/judge";
import { MockPayPalClient, mockTransmissionSig } from "@/lib/paypal";
import type { ActivityRecord } from "@/lib/types";

const NOW = new Date("2026-10-10T12:00:00Z");
const REF = "2026-10-10";
const DEMO_BRIEF =
  "Invoice Ana $450 for brand work, due Friday. When it lands, pay $200 to my contractor Marco.";

function detailFor(
  store: LedgerStore,
  client: MockPayPalClient,
  invoiceId: string,
) {
  return client.getInvoice(invoiceId).then((invoice) =>
    buildInvoiceDetail({
      invoice,
      activity: store.listActivity(),
      plans: store.listPlans(),
      referenceDate: REF,
    }),
  );
}

/** Spine plan approved + executed; invoice SENT, payout gated. */
async function setupExecutedSpine() {
  const store = new LedgerStore();
  const client = new MockPayPalClient();
  const plan = store.addPlan(parseBrief(DEMO_BRIEF, { now: NOW, planId: "plan-detail-1" }));
  store.approvePlan(plan.id);
  await executePlan(store, client, plan.id);
  const [invoice] = await client.listInvoices();
  return { store, client, plan, invoice: invoice! };
}

describe("recordConcernsInvoice", () => {
  const rec = (detail?: Record<string, unknown>): ActivityRecord => ({
    id: "act-x",
    kind: "webhook",
    summary: "s",
    detail,
    createdAt: "2026-10-10T00:00:00Z",
  });

  it("matches every correlation rule the writers use, and nothing else", () => {
    expect(recordConcernsInvoice(rec({ invoiceId: "INV-1" }), "INV-1")).toBe(true);
    expect(recordConcernsInvoice(rec({ resource: { id: "INV-1", status: "PAID" } }), "INV-1")).toBe(true);
    expect(recordConcernsInvoice(rec({ resourceId: "INV-1" }), "INV-1")).toBe(true);
    expect(recordConcernsInvoice(rec({ boundResourceId: "INV-1" }), "INV-1")).toBe(true);
    expect(recordConcernsInvoice(rec({ invoiceIds: ["INV-9", "INV-1"] }), "INV-1")).toBe(true);
    expect(recordConcernsInvoice(rec({ invoiceId: "INV-2" }), "INV-1")).toBe(false);
    expect(recordConcernsInvoice(rec({ resource: { id: "ORDER-1" } }), "INV-1")).toBe(false);
    expect(recordConcernsInvoice(rec({ steps: 2 }), "INV-1")).toBe(false);
    expect(recordConcernsInvoice(rec(undefined), "INV-1")).toBe(false);
    expect(recordConcernsInvoice(rec({ invoiceIds: "INV-1" }), "INV-1")).toBe(false);
  });
});

describe("invoice detail — webhook path", () => {
  it("full spine: create/send entry, then the verified PAID webhook with its event id; plan related and completed", async () => {
    const { store, client, plan, invoice } = await setupExecutedSpine();
    await client.recordInvoicePayment(invoice.id, { value: "450.00", currency_code: "USD" });
    const event = client.emittedEvents.find((e) => e.event_type === "INVOICING.INVOICE.PAID")!;
    await handleWebhookEvent({
      store,
      client,
      headers: {
        "paypal-transmission-id": "trans-d1",
        "paypal-transmission-sig": mockTransmissionSig("trans-d1", event.id),
      },
      event,
    });

    const detail = await detailFor(store, client, invoice.id);
    expect(detail.invoice.status).toBe("PAID");
    expect(detail.invoice.collectedValue).toBe(450);
    expect(detail.invoice.dueAmount).toBe("0.00");
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]!.lineTotal).toBe("450.00");

    const createIdx = detail.timeline.findIndex((e) => e.summary.includes("created and sent"));
    const paidIdx = detail.timeline.findIndex((e) => e.eventId === event.id);
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(paidIdx).toBeGreaterThan(createIdx); // chronological: creation before payment
    expect(detail.timeline[paidIdx]!.kind).toBe("webhook");
    expect(detail.timeline[paidIdx]!.summary).toContain("verified");
    // The payout call itself concerns the payout batch, not this invoice —
    // it must not leak into the invoice timeline.
    expect(detail.timeline.some((e) => e.summary.includes("/v1/payments/payouts"))).toBe(false);

    expect(detail.relatedPlans).toEqual([
      { id: plan.id, brief: DEMO_BRIEF, status: "completed", source: "deterministic" },
    ]);
  });

  it("a rejected-signature record concerns the invoice but never claims verification", async () => {
    const { store, client, invoice } = await setupExecutedSpine();
    await client.recordInvoicePayment(invoice.id, { value: "450.00", currency_code: "USD" });
    const event = client.emittedEvents.find((e) => e.event_type === "INVOICING.INVOICE.PAID")!;
    await handleWebhookEvent({
      store,
      client,
      headers: { "paypal-transmission-id": "trans-bad", "paypal-transmission-sig": "deadbeef" },
      event,
    });
    const detail = await detailFor(store, client, invoice.id);
    const rejected = detail.timeline.find((e) => e.eventId === event.id);
    expect(rejected?.summary).toContain("REJECTED");
    expect(detail.invoice.status).toBe("PAID"); // adapter state moved; the plan did not
    expect(store.getPlan("plan-detail-1")!.status).toBe("awaiting_trigger");
  });
});

describe("invoice detail — sync path", () => {
  it("the reconciler's processed event lands on the timeline, correlated by the recorded resourceId", async () => {
    const { store, client, invoice } = await setupExecutedSpine();
    await client.recordInvoicePayment(invoice.id, { value: "450.00", currency_code: "USD" });
    const event = client.emittedEvents.find((e) => e.event_type === "INVOICING.INVOICE.PAID")!;
    await syncFromPayPal(store, client);

    // The enrichment this run added: sync audit records name their resource.
    const syncRecord = store
      .listActivity()
      .find((a) => a.kind === "webhook" && a.summary.includes("Sync reconciler processed"));
    expect(syncRecord?.detail?.resourceId).toBe(invoice.id);
    expect(syncRecord?.detail?.eventId).toBe(event.id);

    const detail = await detailFor(store, client, invoice.id);
    const entry = detail.timeline.find((e) => e.eventId === event.id);
    expect(entry?.kind).toBe("webhook");
    expect(entry?.summary).toContain("Sync reconciler processed");
    expect(detail.relatedPlans[0]?.status).toBe("completed");
  });
});

describe("invoice detail — reminders and partial payments", () => {
  it("a sent reminder appears on the timeline; the reminding plan is related", async () => {
    const store = new LedgerStore();
    const client = new MockPayPalClient();
    const invoicePlan = store.addPlan(
      parseBrief("Invoice Ana $450 for logo work, due Friday", { now: NOW, planId: "plan-detail-inv" }),
    );
    store.approvePlan(invoicePlan.id);
    await executePlan(store, client, invoicePlan.id);
    const [invoice] = await client.listInvoices();

    const reminderPlan = store.addPlan(
      parseBrief("Remind Ana about her overdue invoice", { now: NOW, planId: "plan-detail-rem" }),
    );
    store.approvePlan(reminderPlan.id);
    await executePlan(store, client, reminderPlan.id);

    const detail = await detailFor(store, client, invoice!.id);
    expect(detail.timeline.some((e) => e.summary.includes("/remind"))).toBe(true);
    expect(detail.relatedPlans.map((p) => p.id).sort()).toEqual(["plan-detail-inv", "plan-detail-rem"]);
  });

  it("partial payment: status and collected amounts move, but no PAID event is invented for the timeline", async () => {
    const { store, client, invoice } = await setupExecutedSpine();
    await client.recordInvoicePayment(invoice.id, { value: "200.00", currency_code: "USD" });
    const detail = await detailFor(store, client, invoice.id);
    expect(detail.invoice.status).toBe("PARTIALLY_PAID");
    expect(detail.invoice.collectedValue).toBe(200);
    expect(detail.invoice.dueAmount).toBe("250.00");
    expect(detail.timeline.some((e) => e.kind === "webhook")).toBe(false);
  });
});

describe("invoice detail — seeded and adapter-direct invoices", () => {
  it("Judge Mode seeded invoices carry exactly the seed record on their timeline", async () => {
    const store = new LedgerStore();
    const client = new MockPayPalClient();
    await seedJudgeScenario(client, store);
    const invoices = await client.listInvoices();
    expect(invoices).toHaveLength(3);
    for (const inv of invoices) {
      const detail = await detailFor(store, client, inv.id);
      expect(detail.timeline).toHaveLength(1);
      expect(detail.timeline[0]!.summary).toContain("Judge Mode");
      expect(detail.relatedPlans).toEqual([]);
    }
    // The spine plan exists but created no invoice yet — it is bound to none.
    const spine = store.listPlans()[0]!;
    expect(spine.status).toBe("pending_approval");
  });

  it("an adapter-direct invoice has an honestly empty timeline and correct line totals", async () => {
    const store = new LedgerStore();
    const client = new MockPayPalClient();
    const created = await client.createInvoice({
      recipient: { name: "Ana", email_address: "ana@example.com" },
      items: [
        { name: "Logo pack", quantity: "2", unit_amount: { currency_code: "USD", value: "30.00" } },
        { name: "Rush fee", quantity: "1", unit_amount: { currency_code: "USD", value: "15.50" } },
      ],
      note: "Direct adapter invoice",
    });
    await client.sendInvoice(created.id);
    const detail = await detailFor(store, client, created.id);
    expect(detail.timeline).toEqual([]);
    expect(detail.relatedPlans).toEqual([]);
    expect(detail.note).toBe("Direct adapter invoice");
    expect(detail.items.map((i) => i.lineTotal)).toEqual(["60.00", "15.50"]);
    expect(detail.invoice.amount).toBe("75.50");
  });

  it("an unexecuted API payout draft gated on this invoice is a related plan", async () => {
    const { store, client, invoice } = await setupExecutedSpine();
    const draft = store.addPlan(
      draftPayoutPlan({ recipientName: "Marco", amount: 120, payWhenInvoicePaid: invoice.id }),
    );
    const detail = await detailFor(store, client, invoice.id);
    expect(detail.relatedPlans.map((p) => p.id)).toContain(draft.id);
    expect(detail.relatedPlans.find((p) => p.id === draft.id)?.source).toBe("api");
  });
});
