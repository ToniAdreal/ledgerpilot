import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { LedgerStore } from "../src/lib/agent/store";
import { parseBrief } from "../src/lib/agent/parser";
import { executePlan, resumeTriggeredSteps } from "../src/lib/agent/executor";
import {
  DraftValidationError,
  draftInvoicePlan,
  draftOrderPlan,
  draftPayoutPlan,
} from "../src/lib/agent/drafts";

function freshRuntime() {
  return { client: new MockPayPalClient(), store: new LedgerStore() };
}

describe("resource plan drafts — the /api/paypal wrappers draft, never execute", () => {
  it("an invoice draft is a pending API plan with a parser-identical step", () => {
    const plan = draftInvoicePlan({
      recipientName: "Ana",
      amount: 450,
      description: "logo work",
      dueDate: "2026-10-16",
    });
    expect(plan.status).toBe("pending_approval");
    expect(plan.source).toBe("api");
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0]!;
    expect(step.type).toBe("create_invoice");
    expect(step.paypalCall).toEqual({ method: "POST", path: "/v2/invoicing/invoices (+ /send)" });
    expect(step.payload).toMatchObject({
      recipient: { name: "Ana", email_address: "ana@example.com" },
      items: [{ name: "logo work", quantity: "1", unit_amount: { currency_code: "USD", value: "450.00" } }],
      dueDate: "2026-10-16",
    });
    // Same shape the deterministic parser produces for the same brief.
    const parsed = parseBrief("Invoice Ana $450 for logo work, due 2026-10-16");
    expect(step.payload).toEqual(parsed.steps[0]!.payload);
    expect(step.description).toBe(parsed.steps[0]!.description);
  });

  it("drafting all three resources calls no PayPal method (the gate has no REST back door)", async () => {
    const { client, store } = freshRuntime();
    store.addPlan(draftInvoicePlan({ recipientName: "Ana", amount: "450", description: "logo work" }));
    store.addPlan(draftOrderPlan({ description: "logo pack", amount: 75 }));
    store.addPlan(draftPayoutPlan({ recipientName: "Marco", amount: 200 }));
    expect(store.listPlans()).toHaveLength(3);
    expect(await client.listInvoices()).toHaveLength(0);
    expect(await client.listOrders()).toHaveLength(0);
    expect(await client.listPayouts()).toHaveLength(0);
    expect(await client.listTransactions()).toHaveLength(0);
    // Executing an unapproved API plan is refused, exactly like any plan.
    const plan = store.listPlans()[0]!;
    await expect(executePlan(store, client, plan.id)).rejects.toThrow(/approval/);
    expect(await client.listInvoices()).toHaveLength(0);
  });

  it("an approved invoice draft executes through the ordinary executor", async () => {
    const { client, store } = freshRuntime();
    const plan = store.addPlan(
      draftInvoicePlan({ recipientName: "Ana", amount: 450, description: "logo work", dueDate: "2026-10-16" }),
    );
    store.approvePlan(plan.id);
    const result = await executePlan(store, client, plan.id);
    expect(result.plan.status).toBe("completed");
    const invoices = await client.listInvoices();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ status: "SENT" });
    expect(invoices[0]!.amount).toEqual({ currency_code: "USD", value: "450.00" });
    expect(invoices[0]!.detail.payment_term?.due_date).toBe("2026-10-16");
  });

  it("an approved order draft executes; an approved payout draft pays out", async () => {
    const { client, store } = freshRuntime();
    const orderPlan = store.addPlan(draftOrderPlan({ description: "studio cable pack", amount: "59.5", currency: "eur" }));
    store.approvePlan(orderPlan.id);
    await executePlan(store, client, orderPlan.id);
    const orders = await client.listOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ status: "CREATED" });
    expect(orders[0]!.purchase_units[0]!.amount).toEqual({ currency_code: "EUR", value: "59.50" });

    const payoutPlan = store.addPlan(draftPayoutPlan({ recipientName: "Marco", amount: 80 }));
    store.approvePlan(payoutPlan.id);
    const result = await executePlan(store, client, payoutPlan.id);
    expect(result.plan.status).toBe("completed");
    const payouts = await client.listPayouts();
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.items[0]).toMatchObject({ transaction_status: "SUCCESS" });
    expect(payouts[0]!.items[0]!.payout_item.amount).toEqual({ currency_code: "USD", value: "80.00" });
  });

  it("a payout gated on a named invoice fires only when THAT invoice is paid", async () => {
    const { client, store } = freshRuntime();
    // Two real invoices exist; the payout is bound to the second one.
    const invA = store.addPlan(draftInvoicePlan({ recipientName: "Ana", amount: 100, description: "icons" }));
    store.approvePlan(invA.id);
    await executePlan(store, client, invA.id);
    const invB = store.addPlan(draftInvoicePlan({ recipientName: "Sam Rivera", amount: 300, description: "site" }));
    store.approvePlan(invB.id);
    await executePlan(store, client, invB.id);
    const [first, second] = await client.listInvoices();

    const gated = store.addPlan(
      draftPayoutPlan({ recipientName: "Marco", amount: 120, payWhenInvoicePaid: second!.id }),
    );
    expect(gated.steps[0]!.trigger).toEqual({ on: "INVOICING.INVOICE.PAID", resourceId: second!.id });
    store.approvePlan(gated.id);
    const executed = await executePlan(store, client, gated.id);
    expect(executed.plan.status).toBe("awaiting_trigger");
    expect(await client.listPayouts()).toHaveLength(0);

    // Paying the WRONG invoice resumes nothing.
    await client.recordInvoicePayment(first!.id, { value: "100.00", currency_code: "USD" });
    const wrong = await resumeTriggeredSteps(store, client, "INVOICING.INVOICE.PAID", first!.id);
    expect(wrong).toHaveLength(0);
    expect(await client.listPayouts()).toHaveLength(0);
    expect(store.getPlan(gated.id)!.status).toBe("awaiting_trigger");

    // Paying the bound invoice releases exactly this payout.
    await client.recordInvoicePayment(second!.id, { value: "300.00", currency_code: "USD" });
    const resumed = await resumeTriggeredSteps(store, client, "INVOICING.INVOICE.PAID", second!.id);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.plan.status).toBe("completed");
    const payouts = await client.listPayouts();
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.items[0]!.payout_item.amount).toEqual({ currency_code: "USD", value: "120.00" });
  });

  it("recipients resolve via the demo book, a slug fallback, or an explicit email", () => {
    const known = draftPayoutPlan({ recipientName: "marco", amount: 10 });
    expect(known.steps[0]!.payload).toMatchObject({
      recipient: { name: "Marco", email_address: "marco@example.com" },
    });
    const unknown = draftPayoutPlan({ recipientName: "Priya", amount: 10 });
    expect(unknown.steps[0]!.payload).toMatchObject({
      recipient: { name: "Priya", email_address: "priya@example.com" },
    });
    const explicit = draftPayoutPlan({ recipientName: "Priya", recipientEmail: "priya@studio.dev", amount: 10 });
    expect(explicit.steps[0]!.payload).toMatchObject({
      recipient: { name: "Priya", email_address: "priya@studio.dev" },
    });
  });

  it("amounts accept numbers and numeric strings, formatted to two decimals", () => {
    expect(draftOrderPlan({ description: "x", amount: 75.5 }).steps[0]!.payload).toMatchObject({
      amount: { currency_code: "USD", value: "75.50" },
    });
    expect(draftOrderPlan({ description: "x", amount: "1,200" }).steps[0]!.payload).toMatchObject({
      amount: { value: "1200.00" },
    });
  });

  it("draft ids never collide with parser- or LLM-minted plan ids", () => {
    const a = draftOrderPlan({ description: "a", amount: 1 });
    const b = draftOrderPlan({ description: "b", amount: 2 });
    const parsed = parseBrief("Sell a logo pack for $75");
    expect(a.id).toMatch(/^plan-api-\d{4}$/);
    expect(b.id).toMatch(/^plan-api-\d{4}$/);
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe(parsed.id);
  });

  it.each([
    ["invoice without recipient", () => draftInvoicePlan({ amount: 10, description: "x" })],
    ["invoice without description", () => draftInvoicePlan({ recipientName: "Ana", amount: 10 })],
    ["order without description", () => draftOrderPlan({ amount: 10 })],
    ["zero amount", () => draftOrderPlan({ description: "x", amount: 0 })],
    ["negative amount", () => draftPayoutPlan({ recipientName: "Marco", amount: -5 })],
    ["non-numeric amount", () => draftOrderPlan({ description: "x", amount: "abc" })],
    ["amount over the cap", () => draftOrderPlan({ description: "x", amount: 100_001 })],
    ["unsupported currency", () => draftOrderPlan({ description: "x", amount: 10, currency: "JPY" })],
    ["relative due date", () => draftInvoicePlan({ recipientName: "Ana", amount: 10, description: "x", dueDate: "Friday" })],
    ["impossible due date", () => draftInvoicePlan({ recipientName: "Ana", amount: 10, description: "x", dueDate: "2026-02-30" })],
    ["invalid recipient email", () => draftPayoutPlan({ recipientName: "Marco", recipientEmail: "not-an-email", amount: 10 })],
    ["empty payout gate", () => draftPayoutPlan({ recipientName: "Marco", amount: 10, payWhenInvoicePaid: 42 })],
  ])("validation rejects: %s", (_label, fn) => {
    expect(fn).toThrow(DraftValidationError);
  });
});
