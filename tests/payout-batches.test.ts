import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { LedgerStore } from "../src/lib/agent/store";
import { executePlan, resumeTriggeredSteps } from "../src/lib/agent/executor";
import {
  DraftValidationError,
  MAX_PAYOUT_BATCH_ITEMS,
  draftInvoicePlan,
  draftPayoutPlan,
} from "../src/lib/agent/drafts";
import { buildPayoutRows, computeSummary } from "../src/lib/console/read-models";
import type { ActionPlan } from "../src/lib/types";

/**
 * Payout batches (CONCEPT.md §3.1: "payout batch builder: agent-drafted
 * batch, per-line validation, approval release").
 *
 * The PayPal adapters were always batch-native (CreatePayoutInput.items),
 * but the agent layer only ever built one-line payouts. These tests pin
 * the batch path end to end: per-line validated drafts, the approval
 * gate unchanged, and execution as exactly ONE Payouts batch.
 */

function freshRuntime() {
  return { client: new MockPayPalClient(), store: new LedgerStore() };
}

const BATCH_ITEMS = [
  { recipientName: "Marco", amount: 200, note: "brand work share" },
  { recipientName: "Ana", amount: "50.5", currency: "eur" },
  { recipientName: "Sam Rivera", recipientEmail: "sam@example.com", amount: 25, currency: "USD" },
];

describe("payout batch drafts — per-line validation, gate intact", () => {
  it("drafts a batch plan: items payload, per-currency totals, pending approval", () => {
    const plan = draftPayoutPlan({ items: BATCH_ITEMS });
    expect(plan.status).toBe("pending_approval");
    expect(plan.source).toBe("api");
    expect(plan.brief).toBe("API draft: payout batch of 3 (total USD 225.00 + EUR 50.50)");
    const step = plan.steps[0]!;
    expect(step.type).toBe("draft_payout");
    expect(step.paypalCall).toEqual({ method: "POST", path: "/v1/payments/payouts" });
    expect(step.description).toContain("batch of 3");
    expect(step.description).toContain("USD 200.00 to Marco");
    const items = (step.payload as { items: unknown[] }).items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      recipient: { name: "Marco", email_address: "marco@example.com" },
      amount: { currency_code: "USD", value: "200.00" },
      note: "brand work share",
    });
    // Lowercase currency + string amount normalise like the single form.
    expect(items[1]).toMatchObject({ amount: { currency_code: "EUR", value: "50.50" } });
    // A line without its own note gets the standard per-recipient default.
    expect(items[1]!.note).toBe("Payout to Ana (LedgerPilot plan)");
    expect(items[2]).toMatchObject({
      recipient: { name: "Sam Rivera", email_address: "sam@example.com" },
      amount: { currency_code: "USD", value: "25.00" },
    });
    // The batch payload carries no single-recipient fields.
    expect(step.payload).not.toHaveProperty("recipient");
    expect(step.payload).not.toHaveProperty("amount");
  });

  it("a batch-level note becomes the default for lines without one", () => {
    const plan = draftPayoutPlan({
      note: "October contractor run",
      items: [{ recipientName: "Marco", amount: 10 }, { recipientName: "Ana", amount: 5, note: "custom" }],
    });
    const items = (plan.steps[0]!.payload as { items: Array<{ note: string }> }).items;
    expect(items[0]!.note).toBe("October contractor run");
    expect(items[1]!.note).toBe("custom");
  });

  it("drafting a batch moves no money, and an unapproved batch cannot execute", async () => {
    const { client, store } = freshRuntime();
    const plan = store.addPlan(draftPayoutPlan({ items: BATCH_ITEMS }));
    expect(await client.listPayouts()).toHaveLength(0);
    expect(await client.listTransactions()).toHaveLength(0);
    await expect(executePlan(store, client, plan.id)).rejects.toThrow(/approval/);
    expect(await client.listPayouts()).toHaveLength(0);
  });

  it("rejects malformed batches with line-named errors", () => {
    const cases: Array<{ input: Parameters<typeof draftPayoutPlan>[0]; pattern: RegExp }> = [
      { input: { items: "not-an-array" }, pattern: /'items' must be an array/ },
      { input: { items: [] }, pattern: /at least one payout line/ },
      {
        input: { items: Array.from({ length: MAX_PAYOUT_BATCH_ITEMS + 1 }, () => ({ recipientName: "Marco", amount: 1 })) },
        pattern: new RegExp(`at most ${MAX_PAYOUT_BATCH_ITEMS}`),
      },
      { input: { items: [42] }, pattern: /items\[0\] must be an object/ },
      { input: { items: [{ amount: 10 }] }, pattern: /items\[0\]: 'recipientName' is required/ },
      { input: { items: [{ recipientName: "Marco", amount: 10 }, { recipientName: "Ana", amount: 0 }] }, pattern: /items\[1\]: 'amount' must be greater than zero/ },
      { input: { items: [{ recipientName: "Marco", amount: 100_001 }] }, pattern: /items\[0\]: 'amount' must not exceed/ },
      { input: { items: [{ recipientName: "Marco", amount: "abc" }] }, pattern: /items\[0\]: 'amount' is required/ },
      { input: { items: [{ recipientName: "Marco", amount: 10, currency: "JPY" }] }, pattern: /items\[0\]: 'currency' must be one of/ },
      { input: { items: [{ recipientName: "Marco", recipientEmail: "not-an-email", amount: 10 }] }, pattern: /items\[0\]: 'recipientEmail' must be a valid email/ },
      {
        input: { items: BATCH_ITEMS, recipientName: "Marco", amount: 200 },
        pattern: /cannot be combined/,
      },
    ];
    for (const { input, pattern } of cases) {
      let caught: unknown;
      try {
        draftPayoutPlan(input);
      } catch (err) {
        caught = err;
      }
      expect(caught, JSON.stringify(input)).toBeInstanceOf(DraftValidationError);
      expect((caught as DraftValidationError).message).toMatch(pattern);
      expect((caught as DraftValidationError).status).toBe(400);
    }
  });
});

describe("payout batch execution — one batch through the gate", () => {
  it("an approved batch executes as exactly ONE PayPal batch with per-item rows and totals", async () => {
    const { client, store } = freshRuntime();
    const plan = store.addPlan(draftPayoutPlan({ items: BATCH_ITEMS }));
    store.approvePlan(plan.id);
    const result = await executePlan(store, client, plan.id);
    expect(result.plan.status).toBe("completed");
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]!.outcome).toBe("executed");

    const batches = await client.listPayouts();
    expect(batches).toHaveLength(1);
    const batch = batches[0]!;
    expect(batch.batch_header.batch_status).toBe("SUCCESS");
    expect(batch.items).toHaveLength(3);
    expect(batch.items.map((i) => i.transaction_status)).toEqual(["SUCCESS", "SUCCESS", "SUCCESS"]);
    expect(result.outcomes[0]!.resultId).toBe(batch.batch_header.payout_batch_id);

    // One transaction per line, signed negative, in line order.
    const txns = await client.listTransactions();
    expect(txns.map((t) => t.transaction_amount.value)).toEqual(["-200.00", "-50.50", "-25.00"]);

    // The audit record names the batch and every line.
    const audit = store.listActivity(plan.id).filter((a) => a.kind === "paypal_call");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.summary).toContain(batch.batch_header.payout_batch_id);
    expect(audit[0]!.summary).toContain("3 items");
    expect(audit[0]!.summary).toContain("USD 200.00 to Marco");
    expect(audit[0]!.detail).toMatchObject({ itemCount: 3 });

    // The console flattens the one batch to three rows under one batch id,
    // and the KPI totals stay grouped per currency.
    const rows = buildPayoutRows(batches);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.batchId)).size).toBe(1);
    const summary = computeSummary({
      invoices: [],
      orders: [],
      payouts: batches,
      disputes: [],
      transactions: txns,
      plans: store.listPlans(),
      activity: store.listActivity(),
      referenceDate: "2026-10-10",
    });
    // (computeSummary emits currency totals in its established sorted order.)
    expect(summary.payoutsSent).toEqual([
      { currency_code: "EUR", value: "50.50" },
      { currency_code: "USD", value: "225.00" },
    ]);
  });

  it("a batch gated on one invoice releases whole, only when THAT invoice is paid", async () => {
    const { client, store } = freshRuntime();
    const invoiceA = store.addPlan(draftInvoicePlan({ recipientName: "Ana", amount: 450, description: "brand work" }, { planId: "plan-inv-a" }));
    const invoiceB = store.addPlan(draftInvoicePlan({ recipientName: "Sam Rivera", amount: 300, description: "consulting" }, { planId: "plan-inv-b" }));
    store.approvePlan(invoiceA.id);
    store.approvePlan(invoiceB.id);
    const execA = await executePlan(store, client, invoiceA.id);
    const execB = await executePlan(store, client, invoiceB.id);
    const idA = execA.outcomes[0]!.resultId!;
    const idB = execB.outcomes[0]!.resultId!;

    const batchPlan = store.addPlan(
      draftPayoutPlan({ items: BATCH_ITEMS, payWhenInvoicePaid: idA }, { planId: "plan-batch" }),
    );
    expect(batchPlan.steps[0]!.trigger).toEqual({ on: "INVOICING.INVOICE.PAID", resourceId: idA });
    store.approvePlan(batchPlan.id);
    const deferred = await executePlan(store, client, batchPlan.id);
    expect(deferred.plan.status).toBe("awaiting_trigger");
    expect(await client.listPayouts()).toHaveLength(0);

    // Paying the WRONG invoice resumes nothing.
    await client.recordInvoicePayment(idB, { value: "300.00", currency_code: "USD" });
    const wrong = await resumeTriggeredSteps(store, client, "INVOICING.INVOICE.PAID", idB);
    expect(wrong).toHaveLength(0);
    expect(store.getPlan(batchPlan.id)!.status).toBe("awaiting_trigger");
    expect(await client.listPayouts()).toHaveLength(0);

    // Paying the bound invoice releases the whole batch exactly once.
    await client.recordInvoicePayment(idA, { value: "450.00", currency_code: "USD" });
    const resumed = await resumeTriggeredSteps(store, client, "INVOICING.INVOICE.PAID", idA);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.plan.status).toBe("completed");
    const batches = await client.listPayouts();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.items).toHaveLength(3);

    // A repeat event is a no-op — the batch never pays twice.
    const again = await resumeTriggeredSteps(store, client, "INVOICING.INVOICE.PAID", idA);
    expect(again).toHaveLength(0);
    expect(await client.listPayouts()).toHaveLength(1);
  });

  it("a step with an explicitly empty items list fails the plan and pays nothing", async () => {
    const { client, store } = freshRuntime();
    const malformed: ActionPlan = {
      id: "plan-empty-batch",
      brief: "hand-built malformed batch",
      steps: [
        {
          type: "draft_payout",
          description: "Pay out a batch of 0",
          paypalCall: { method: "POST", path: "/v1/payments/payouts" },
          payload: { items: [] },
        },
      ],
      status: "pending_approval",
      createdAt: new Date("2026-10-10T00:00:00Z").toISOString(),
      source: "api",
    };
    const plan = store.addPlan(malformed);
    store.approvePlan(plan.id);
    const result = await executePlan(store, client, plan.id);
    expect(result.plan.status).toBe("failed");
    expect(result.outcomes[0]!.outcome).toBe("failed");
    expect(result.outcomes[0]!.error).toMatch(/empty items list/);
    expect(await client.listPayouts()).toHaveLength(0);
  });
});
