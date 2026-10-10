import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { LedgerStore } from "../src/lib/agent/store";
import { parseBrief } from "../src/lib/agent/parser";
import {
  buildActivityRows,
  buildInvoiceRows,
  computeSummary,
} from "../src/lib/console/read-models";

const ANA = { name: "Ana", email_address: "ana@example.com" };
const MARCO = { name: "Marco", email_address: "marco@example.com" };

async function invoiceFixture() {
  const client = new MockPayPalClient({ sampleDispute: true });
  // Invoice 1: $450 due 2026-10-16, SENT, unpaid.
  const inv1 = await client.createInvoice({
    recipient: ANA,
    items: [{ name: "Logo work", quantity: "1", unit_amount: { currency_code: "USD", value: "450.00" } }],
    dueDate: "2026-10-16",
  });
  await client.sendInvoice(inv1.id);
  // Invoice 2: €300 due 2026-10-01, partially paid €100 -> overdue at ref 2026-10-10.
  const inv2 = await client.createInvoice({
    recipient: MARCO,
    items: [{ name: "Consulting", quantity: "1", unit_amount: { currency_code: "EUR", value: "300.00" } }],
    dueDate: "2026-10-01",
  });
  await client.sendInvoice(inv2.id);
  await client.recordInvoicePayment(inv2.id, { value: "100.00", currency_code: "EUR" });
  // Invoice 3: $120 fully paid.
  const inv3 = await client.createInvoice({
    recipient: ANA,
    items: [{ name: "Icons", quantity: "1", unit_amount: { currency_code: "USD", value: "120.00" } }],
  });
  await client.sendInvoice(inv3.id);
  await client.recordInvoicePayment(inv3.id, { value: "120.00", currency_code: "USD" });
  return client;
}

describe("console invoice rows", () => {
  it("projects recipient, amounts, due date and overdue flag; newest first", async () => {
    const client = await invoiceFixture();
    const rows = buildInvoiceRows(await client.listInvoices(), "2026-10-10");
    expect(rows).toHaveLength(3);
    // Newest first: inv3 (paid), inv2 (partial), inv1 (sent).
    expect(rows.map((r) => r.status)).toEqual(["PAID", "PARTIALLY_PAID", "SENT"]);

    const partial = rows[1]!;
    expect(partial.recipientName).toBe("Marco");
    expect(partial.currency).toBe("EUR");
    expect(partial.amount).toBe("300.00");
    expect(partial.dueAmount).toBe("200.00");
    expect(partial.collectedValue).toBe(100);
    expect(partial.dueDate).toBe("2026-10-01");
    expect(partial.overdue).toBe(true);

    const sent = rows[2]!;
    expect(sent.invoiceNumber).toMatch(/^LP-/);
    expect(sent.dueDate).toBe("2026-10-16");
    expect(sent.overdue).toBe(false); // due in the future at the reference date
    expect(sent.collectedValue).toBe(0);

    const paid = rows[0]!;
    expect(paid.collectedValue).toBe(120);
    expect(paid.overdue).toBe(false); // paid invoices are never overdue
  });
});

describe("console summary KPIs", () => {
  it("groups money by currency and counts approvals / disputes", async () => {
    const client = await invoiceFixture();
    const store = new LedgerStore();
    const pending = parseBrief("Invoice Ana $50 for sketches", { now: new Date("2026-10-10T00:00:00Z") });
    store.addPlan(pending); // stays pending_approval
    const approved = parseBrief("Invoice Ana $75 for sketches", { now: new Date("2026-10-10T00:00:00Z") });
    store.addPlan(approved);
    store.approvePlan(approved.id);

    const summary = computeSummary({
      invoices: await client.listInvoices(),
      orders: await client.listOrders(),
      payouts: await client.listPayouts(),
      disputes: await client.listDisputes(),
      plans: store.listPlans(),
      activity: store.listActivity(),
      referenceDate: "2026-10-10",
    });

    // Outstanding: USD 450.00 open + EUR 200.00 still due; never cross-summed.
    expect(summary.outstanding).toEqual([
      { currency_code: "EUR", value: "200.00" },
      { currency_code: "USD", value: "450.00" },
    ]);
    // Collected: EUR 100.00 partial + USD 120.00 paid in full.
    expect(summary.collected).toEqual([
      { currency_code: "EUR", value: "100.00" },
      { currency_code: "USD", value: "120.00" },
    ]);
    expect(summary.pendingApprovals).toBe(1);
    expect(summary.awaitingTrigger).toBe(0);
    expect(summary.openDisputes).toBe(1); // the flagged sample dispute
    expect(summary.counts).toEqual({ invoices: 3, orders: 0, payouts: 0, plans: 2, activity: 3 });
  });

  it("empty state yields zeroed KPIs, not errors", () => {
    const summary = computeSummary({
      invoices: [],
      orders: [],
      payouts: [],
      disputes: [],
      plans: [],
      activity: [],
      referenceDate: "2026-10-10",
    });
    expect(summary.outstanding).toEqual([]);
    expect(summary.collected).toEqual([]);
    expect(summary.pendingApprovals).toBe(0);
    expect(summary.openDisputes).toBe(0);
    expect(summary.counts.invoices).toBe(0);
  });
});

describe("console activity rows", () => {
  it("is newest-first, surfaces webhook event ids, and flattens detail", () => {
    const store = new LedgerStore();
    store.record({ kind: "system", summary: "boot" });
    store.record({
      kind: "webhook",
      summary: "Webhook WH-1 verified",
      detail: { eventId: "WH-1", eventType: "INVOICING.INVOICE.PAID", verified: true },
    });
    const rows = buildActivityRows(store.listActivity());
    expect(rows.map((r) => r.summary)).toEqual(["Webhook WH-1 verified", "boot"]);
    expect(rows[0]!.eventId).toBe("WH-1");
    expect(rows[0]!.kind).toBe("webhook");
    expect(JSON.parse(rows[0]!.detailJson)).toMatchObject({ verified: true });
    expect(rows[1]!.eventId).toBeUndefined();
    expect(rows[1]!.detailJson).toBe("");
    expect(rows[1]!.planId).toBe("");
  });
});
