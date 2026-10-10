import { describe, expect, it } from "vitest";
import {
  BriefParseError,
  LedgerStore,
  executePlan,
  parseBrief,
  parseDueDate,
  resumeTriggeredSteps,
} from "@/lib/agent";
import { MockPayPalClient } from "@/lib/paypal";

// Saturday, Oct 10 2026 (UTC) — the demo-spine reference date.
const NOW = new Date("2026-10-10T12:00:00Z");
const DEMO_BRIEF =
  "Invoice Ana $450 for brand work, due Friday. When it lands, pay $200 to my contractor Marco.";

describe("deterministic brief parser", () => {
  it("parses the demo-spine brief into an invoice step + a payment-gated payout step", () => {
    const plan = parseBrief(DEMO_BRIEF, { now: NOW, planId: "plan-test-1" });
    expect(plan.status).toBe("pending_approval");
    expect(plan.steps).toHaveLength(2);

    const [invoice, payout] = plan.steps;
    expect(invoice!.type).toBe("create_invoice");
    expect(invoice!.paypalCall).toEqual({ method: "POST", path: "/v2/invoicing/invoices (+ /send)" });
    const invPayload = invoice!.payload as { dueDate?: string; items: Array<{ unit_amount: { value: string } }> };
    expect(invPayload.items[0]!.unit_amount.value).toBe("450.00");
    expect(invPayload.dueDate).toBe("2026-10-16"); // the Friday after Sat Oct 10

    expect(payout!.type).toBe("draft_payout");
    expect(payout!.trigger).toEqual({ on: "INVOICING.INVOICE.PAID" });
    const payPayload = payout!.payload as { amount: { value: string }; recipient: { name: string; email_address: string } };
    expect(payPayload.amount.value).toBe("200.00");
    expect(payPayload.recipient).toEqual({ name: "Marco", email_address: "marco@example.com" });
  });

  it("parses a single invoice with 'due in 5 days'", () => {
    const plan = parseBrief("Invoice Ana $1,250.50 for website redesign, due in 5 days", { now: NOW });
    expect(plan.steps).toHaveLength(1);
    const payload = plan.steps[0]!.payload as { dueDate?: string; items: Array<{ unit_amount: { value: string } }> };
    expect(payload.dueDate).toBe("2026-10-15");
    expect(payload.items[0]!.unit_amount.value).toBe("1250.50");
  });

  it("parses immediate payouts in both word orders, with no trigger", () => {
    const a = parseBrief("Pay $200 to Marco for hosting help", { now: NOW });
    expect(a.steps[0]!.type).toBe("draft_payout");
    expect(a.steps[0]!.trigger).toBeUndefined();
    const b = parseBrief("Pay Marco $75", { now: NOW });
    expect((b.steps[0]!.payload as { amount: { value: string } }).amount.value).toBe("75.00");
  });

  it("parses a sell brief into an Orders v2 step and honors € amounts", () => {
    const plan = parseBrief("Sell a studio cable pack for $59", { now: NOW });
    expect(plan.steps[0]!.type).toBe("create_order");
    expect(plan.steps[0]!.paypalCall.path).toBe("/v2/checkout/orders");
    const euro = parseBrief("Invoice Ana €300 for illustrations, due tomorrow", { now: NOW });
    const payload = euro.steps[0]!.payload as { dueDate?: string; items: Array<{ unit_amount: { currency_code: string } }> };
    expect(payload.items[0]!.unit_amount.currency_code).toBe("EUR");
    expect(payload.dueDate).toBe("2026-10-11");
  });

  it("parses a reminder brief", () => {
    const plan = parseBrief("Remind Ana about invoice LP-000123", { now: NOW });
    expect(plan.steps[0]!.type).toBe("send_reminder");
    expect((plan.steps[0]!.payload as { invoiceRef: string }).invoiceRef).toBe("LP-000123");
  });

  it("rejects briefs with no money action", () => {
    expect(() => parseBrief("Tell me a joke about accounting", { now: NOW })).toThrow(BriefParseError);
    expect(() => parseBrief("   ", { now: NOW })).toThrow(BriefParseError);
  });

  it("resolves due dates deterministically", () => {
    expect(parseDueDate("Friday", NOW)).toBe("2026-10-16");
    expect(parseDueDate("in 3 days", NOW)).toBe("2026-10-13");
    expect(parseDueDate("2026-11-01", NOW)).toBe("2026-11-01");
    expect(parseDueDate("whenever", NOW)).toBeUndefined();
  });
});

describe("approval gate + executor", () => {
  function setup() {
    const store = new LedgerStore();
    const client = new MockPayPalClient();
    const plan = store.addPlan(parseBrief(DEMO_BRIEF, { now: NOW, planId: "plan-exec-1" }));
    return { store, client, plan };
  }

  it("refuses to execute an unapproved or rejected plan — and executes nothing", async () => {
    const { store, client, plan } = setup();
    await expect(executePlan(store, client, plan.id)).rejects.toThrow(/requires approval/);
    store.rejectPlan(plan.id);
    await expect(executePlan(store, client, plan.id)).rejects.toThrow(/requires approval/);
    expect(await client.listInvoices()).toHaveLength(0);
    expect(await client.listPayouts()).toHaveLength(0);
  });

  it("runs invoice now, defers the payout, and closes the loop when payment lands", async () => {
    const { store, client, plan } = setup();
    store.approvePlan(plan.id);
    const first = await executePlan(store, client, plan.id);
    expect(first.plan.status).toBe("awaiting_trigger");
    expect(first.outcomes.map((o) => o.outcome)).toEqual(["executed", "deferred"]);

    const invoices = await client.listInvoices();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.status).toBe("SENT");
    expect(await client.listPayouts()).toHaveLength(0); // gate held: no payout before payment

    // Payment leg (mock record-payment stands in for the buyer paying).
    await client.recordInvoicePayment(invoices[0]!.id, { value: "450.00", currency_code: "USD" });
    const resumed = await resumeTriggeredSteps(store, client, "INVOICING.INVOICE.PAID");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.plan.status).toBe("completed");

    const payouts = await client.listPayouts();
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.batch_header.batch_status).toBe("SUCCESS");
    const txns = await client.listTransactions();
    expect(txns.map((t) => t.transaction_amount.value)).toEqual(["450.00", "-200.00"]);

    // The audit trail tells the whole story in order.
    const kinds = store.listActivity(plan.id).map((a) => a.kind);
    expect(kinds).toEqual(["plan", "approval", "system", "paypal_call", "system", "webhook", "paypal_call"]);
  });

  it("completes a single-step order plan outright", async () => {
    const store = new LedgerStore();
    const client = new MockPayPalClient();
    const plan = store.addPlan(parseBrief("Sell a studio cable pack for $59", { now: NOW, planId: "plan-order-1" }));
    store.approvePlan(plan.id);
    const result = await executePlan(store, client, plan.id);
    expect(result.plan.status).toBe("completed");
    const orders = await client.listOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe("CREATED");
  });

  it("does not resume plans for unrelated trigger events", async () => {
    const { store, client, plan } = setup();
    store.approvePlan(plan.id);
    await executePlan(store, client, plan.id);
    const resumed = await resumeTriggeredSteps(store, client, "PAYMENT.CAPTURE.COMPLETED");
    expect(resumed).toHaveLength(0);
    expect(store.getPlan(plan.id)!.status).toBe("awaiting_trigger");
  });
});

describe("webhook idempotency bookkeeping", () => {
  it("marks each event id processed exactly once", () => {
    const store = new LedgerStore();
    expect(store.markEventProcessed("WH-1")).toBe(true);
    expect(store.markEventProcessed("WH-1")).toBe(false);
    expect(store.hasProcessedEvent("WH-1")).toBe(true);
    expect(store.hasProcessedEvent("WH-2")).toBe(false);
  });
});
