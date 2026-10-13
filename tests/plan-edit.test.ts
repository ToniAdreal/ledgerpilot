/**
 * Plan amendment — CONCEPT.md §3.1's plan-review "Edit" (amounts).
 *
 * Pinned here:
 *  - stepAmounts extraction for every step shape (invoice line item,
 *    order, single payout, batch lines, reminder = none);
 *  - a pending plan's amounts can be amended: payload updated, step
 *    description regenerated in the builder's exact format, plan
 *    still pending_approval, amendment written to the audit log;
 *  - the gate rules: unknown plan 404; approved / rejected /
 *    completed plans 409 (approval covers exactly what was reviewed);
 *    invalid amounts surface the drafts module's own messages;
 *    reminder steps, out-of-range steps, duplicate steps, batch
 *    shape mismatches, and no-change edits are all 400;
 *  - the gate invariant: amending moves no money, and an amended
 *    plan still executes nothing until approved — then runs the
 *    full loop at the AMENDED amounts;
 *  - the review view-model: canEdit only from pending_approval,
 *    editable amounts on review steps, and collectAmountEdits
 *    sending only actual changes.
 */
import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { LedgerStore } from "../src/lib/agent/store";
import { parseBrief } from "../src/lib/agent/parser";
import { draftPayoutPlan } from "../src/lib/agent/drafts";
import { PlanEditError, editPlanAmounts, stepAmounts } from "../src/lib/agent/edit";
import { executePlan, resumeTriggeredSteps } from "../src/lib/agent/executor";
import { buildPlanReview, collectAmountEdits, amountDraftKey } from "../src/lib/command/command-bar";

const NOW = new Date("2026-10-10T00:00:00Z");
const SPINE = "Invoice Ana $450 for brand work, due Friday. When it lands, pay $200 to my contractor Marco.";

function spinePlan(store: LedgerStore) {
  const plan = parseBrief(SPINE, { now: NOW });
  store.addPlan(plan);
  return plan;
}

describe("plan amendment — stepAmounts extraction", () => {
  it("extracts the amount of every money step shape; reminders carry none", () => {
    const store = new LedgerStore();
    const plan = spinePlan(store);
    expect(stepAmounts(plan.steps[0]!)).toEqual([{ itemIndex: null, amount: { currency_code: "USD", value: "450.00" } }]);
    expect(stepAmounts(plan.steps[1]!)).toEqual([{ itemIndex: null, amount: { currency_code: "USD", value: "200.00" } }]);

    const reminder = parseBrief("Remind Marco about his overdue invoice", { now: NOW });
    expect(stepAmounts(reminder.steps[0]!)).toEqual([]);

    const order = parseBrief("Sell a logo pack for $75", { now: NOW });
    expect(stepAmounts(order.steps[0]!)).toEqual([{ itemIndex: null, amount: { currency_code: "USD", value: "75.00" } }]);

    const batch = draftPayoutPlan({
      items: [
        { recipientName: "Marco", amount: 200, currency: "USD" },
        { recipientName: "Ana", amount: "50.50", currency: "eur" },
      ],
    });
    expect(stepAmounts(batch.steps[0]!)).toEqual([
      { itemIndex: 0, amount: { currency_code: "USD", value: "200.00" } },
      { itemIndex: 1, amount: { currency_code: "EUR", value: "50.50" } },
    ]);
  });
});

describe("plan amendment — editing a pending plan", () => {
  it("amends invoice + payout amounts: payload, regenerated descriptions, audit record, still pending", () => {
    const store = new LedgerStore();
    const plan = spinePlan(store);
    const updated = editPlanAmounts(store, plan.id, {
      edits: [
        { stepIndex: 0, amount: 500 },
        { stepIndex: 1, amount: "250", currency: "usd" },
      ],
    });
    expect(updated.status).toBe("pending_approval");
    expect(updated.brief).toBe(plan.brief); // the original ask is never rewritten
    const invoicePayload = updated.steps[0]!.payload as { items: Array<{ unit_amount: unknown }> };
    expect(invoicePayload.items[0]!.unit_amount).toEqual({ currency_code: "USD", value: "500.00" });
    expect(updated.steps[0]!.description).toBe("Invoice Ana USD 500.00 for brand work, due 2026-10-16 — create the draft and send it");
    const payoutPayload = updated.steps[1]!.payload as { amount: unknown };
    expect(payoutPayload.amount).toEqual({ currency_code: "USD", value: "250.00" });
    expect(updated.steps[1]!.description).toBe("Pay out USD 250.00 to Marco — only after the invoice payment lands");
    expect(updated.steps[1]!.trigger).toEqual({ on: "INVOICING.INVOICE.PAID" }); // the gate survives the edit

    const audit = store.listActivity().filter((r) => r.kind === "system" && r.summary.includes("amended before approval"));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.summary).toContain("step 1 amount USD 450.00 → USD 500.00");
    expect(audit[0]!.summary).toContain("step 2 amount USD 200.00 → USD 250.00");
  });

  it("amends an order's amount and currency", () => {
    const store = new LedgerStore();
    const plan = parseBrief("Sell a logo pack for $75", { now: NOW });
    store.addPlan(plan);
    const updated = editPlanAmounts(store, plan.id, { edits: [{ stepIndex: 0, amount: "80", currency: "eur" }] });
    expect((updated.steps[0]!.payload as { amount: unknown }).amount).toEqual({ currency_code: "EUR", value: "80.00" });
    expect(updated.steps[0]!.description).toBe("Create a checkout order: logo pack — EUR 80.00");
  });

  it("amends batch payout lines and regenerates the per-currency totals", () => {
    const store = new LedgerStore();
    const batch = draftPayoutPlan({
      items: [
        { recipientName: "Marco", amount: 200, currency: "USD" },
        { recipientName: "Ana", amount: 50.5, currency: "EUR" },
        { recipientName: "Sam Rivera", amount: 25, currency: "USD" },
      ],
    });
    store.addPlan(batch);
    const updated = editPlanAmounts(store, batch.id, {
      edits: [{ stepIndex: 0, items: [{ index: 0, amount: 225 }, { index: 1, amount: 60, currency: "EUR" }] }],
    });
    const items = (updated.steps[0]!.payload as { items: Array<{ amount: unknown }> }).items;
    expect(items[0]!.amount).toEqual({ currency_code: "USD", value: "225.00" });
    expect(items[1]!.amount).toEqual({ currency_code: "EUR", value: "60.00" });
    expect(items[2]!.amount).toEqual({ currency_code: "USD", value: "25.00" });
    expect(updated.steps[0]!.description).toContain("(total USD 250.00 + EUR 60.00)");
  });
});

describe("plan amendment — the gate rules", () => {
  it("refuses an unknown plan (404) and non-pending plans (409), leaving amounts untouched", async () => {
    const store = new LedgerStore();
    expect(() => editPlanAmounts(store, "plan-nope", { edits: [{ stepIndex: 0, amount: 1 }] })).toThrowError(
      expect.objectContaining({ status: 404 }),
    );

    const plan = spinePlan(store);
    store.approvePlan(plan.id);
    expect(() => editPlanAmounts(store, plan.id, { edits: [{ stepIndex: 0, amount: 1 }] })).toThrowError(
      expect.objectContaining({ status: 409 }),
    );
    expect(stepAmounts(store.getPlan(plan.id)!.steps[0]!)).toEqual([
      { itemIndex: null, amount: { currency_code: "USD", value: "450.00" } },
    ]);

    const rejected = spinePlan(store);
    store.rejectPlan(rejected.id);
    expect(() => editPlanAmounts(store, rejected.id, { edits: [{ stepIndex: 0, amount: 1 }] })).toThrowError(PlanEditError);
  });

  it("refuses invalid amounts with the drafts module's own messages", () => {
    const store = new LedgerStore();
    const plan = spinePlan(store);
    for (const bad of [0, -5, 100001, "abc"]) {
      expect(() => editPlanAmounts(store, plan.id, { edits: [{ stepIndex: 0, amount: bad }] })).toThrowError(
        expect.objectContaining({ status: 400 }),
      );
    }
    expect(() => editPlanAmounts(store, plan.id, { edits: [{ stepIndex: 0, amount: 10, currency: "JPY" }] })).toThrowError(
      /'currency' must be one of USD, EUR, GBP/,
    );
    expect(() => editPlanAmounts(store, plan.id, { edits: [{ stepIndex: 0, amount: 0 }] })).toThrowError(
      /'amount' must be greater than zero/,
    );
  });

  it("refuses reminder steps, out-of-range or duplicate steps, batch shape mismatches, and no-change edits", () => {
    const store = new LedgerStore();
    const reminder = parseBrief("Remind Marco about his overdue invoice", { now: NOW });
    store.addPlan(reminder);
    expect(() => editPlanAmounts(store, reminder.id, { edits: [{ stepIndex: 0, amount: 10 }] })).toThrowError(
      /carries no amount/,
    );

    const plan = spinePlan(store);
    expect(() => editPlanAmounts(store, plan.id, { edits: [{ stepIndex: 9, amount: 10 }] })).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
    expect(() =>
      editPlanAmounts(store, plan.id, { edits: [{ stepIndex: 0, amount: 10 }, { stepIndex: 0, amount: 20 }] }),
    ).toThrowError(/amended twice/);
    expect(() => editPlanAmounts(store, plan.id, { edits: [{ stepIndex: 0, items: [{ index: 0, amount: 10 }] }] })).toThrowError(
      /not a payout batch/,
    );
    expect(() => editPlanAmounts(store, plan.id, { edits: [{ stepIndex: 0, amount: 450 }] })).toThrowError(/changes nothing/);
    expect(() => editPlanAmounts(store, plan.id, { edits: [] })).toThrowError(expect.objectContaining({ status: 400 }));
    expect(() => editPlanAmounts(store, plan.id, {})).toThrowError(expect.objectContaining({ status: 400 }));

    const batch = draftPayoutPlan({ items: [{ recipientName: "Marco", amount: 200 }] });
    store.addPlan(batch);
    expect(() => editPlanAmounts(store, batch.id, { edits: [{ stepIndex: 0, amount: 10 }] })).toThrowError(/payout batch/);
    expect(() =>
      editPlanAmounts(store, batch.id, { edits: [{ stepIndex: 0, items: [{ index: 3, amount: 10 }] }] }),
    ).toThrowError(expect.objectContaining({ status: 400 }));
  });
});

describe("plan amendment — the amended plan still runs the gate, at the amended amounts", () => {
  it("full loop: amend → nothing executes unapproved → approve → execute → pay → payout at the amended amount", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    const plan = spinePlan(store);
    const amended = editPlanAmounts(store, plan.id, {
      edits: [
        { stepIndex: 0, amount: 500 },
        { stepIndex: 1, amount: 250 },
      ],
    });
    expect(amended.status).toBe("pending_approval");
    expect(await client.listInvoices()).toHaveLength(0); // amending moved no money

    await expect(executePlan(store, client, plan.id)).rejects.toThrow(/approval/);
    store.approvePlan(plan.id);
    const executed = await executePlan(store, client, plan.id);
    expect(executed.plan.status).toBe("awaiting_trigger");
    const invoices = await client.listInvoices();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.amount).toEqual({ currency_code: "USD", value: "500.00" });

    await client.recordInvoicePayment(invoices[0]!.id, { value: "500.00", currency_code: "USD" });
    const resumed = await resumeTriggeredSteps(store, client, "INVOICING.INVOICE.PAID", invoices[0]!.id);
    expect(resumed.map((r) => r.plan.id)).toEqual([plan.id]);
    expect(store.getPlan(plan.id)!.status).toBe("completed");
    const payouts = await client.listPayouts();
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.items[0]!.payout_item.amount).toEqual({ currency_code: "USD", value: "250.00" });
    const tx = await client.listTransactions();
    expect(tx.map((t) => t.transaction_amount.value)).toEqual(expect.arrayContaining(["500.00", "-250.00"]));
  });
});

describe("plan amendment — the review view-model", () => {
  it("canEdit is offered only from pending_approval; review steps carry their editable amounts", () => {
    const store = new LedgerStore();
    const plan = spinePlan(store);
    const review = buildPlanReview(plan);
    expect(review.actions.canEdit).toBe(true);
    expect(review.steps[0]!.editable).toEqual([{ itemIndex: null, amount: { currency_code: "USD", value: "450.00" } }]);
    expect(review.steps[1]!.editable).toEqual([{ itemIndex: null, amount: { currency_code: "USD", value: "200.00" } }]);
    store.approvePlan(plan.id);
    expect(buildPlanReview(store.getPlan(plan.id)!).actions.canEdit).toBe(false);
  });

  it("collectAmountEdits sends only actual changes, formatted for the wire", () => {
    const plan = parseBrief(SPINE, { now: NOW });
    const review = buildPlanReview(plan);
    // Untouched drafts → null (no edit is sent).
    expect(
      collectAmountEdits(review, {
        [amountDraftKey(0, null)]: { amount: "450", currency: "USD" },
        [amountDraftKey(1, null)]: { amount: "200.00", currency: "USD" },
      }),
    ).toBeNull();
    // One change → one edit; the unchanged step is not included.
    expect(
      collectAmountEdits(review, {
        [amountDraftKey(0, null)]: { amount: "450", currency: "USD" },
        [amountDraftKey(1, null)]: { amount: "250", currency: "USD" },
      }),
    ).toEqual([{ stepIndex: 1, amount: "250", currency: "USD" }]);
    // An unparseable amount is forwarded so the server can refuse it by name.
    expect(
      collectAmountEdits(review, {
        [amountDraftKey(0, null)]: { amount: "abc", currency: "USD" },
      }),
    ).toEqual([{ stepIndex: 0, amount: "abc", currency: "USD" }]);
  });
});
