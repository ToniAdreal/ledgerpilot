import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { LedgerStore } from "../src/lib/agent/store";
import { executePlan } from "../src/lib/agent/executor";
import { syncFromPayPal } from "../src/lib/agent/reconciler";
import { buildInvoiceRows } from "../src/lib/console/read-models";
import {
  JUDGE_BRIEF,
  JUDGE_REFERENCE_DATE,
  JudgeModeError,
  getJudgeScenario,
  getJudgeState,
  isJudgeSeeded,
  seedJudgeScenario,
  simulateJudgeInvoicePayment,
} from "../src/lib/judge";

function freshRuntime() {
  return { client: new MockPayPalClient(), store: new LedgerStore() };
}

describe("judge scenario descriptor", () => {
  it("carries the canonical spine brief, reference date, and a 5-step script", () => {
    const scenario = getJudgeScenario();
    expect(scenario.brief).toBe(JUDGE_BRIEF);
    expect(scenario.brief).toContain("Invoice Ana $450 for brand work, due Friday");
    expect(scenario.brief).toContain("pay $200 to my contractor Marco");
    expect(scenario.referenceDate).toBe(JUDGE_REFERENCE_DATE);
    expect(scenario.referenceDate).toBe("2026-10-10");
    expect(scenario.steps).toHaveLength(5);
    expect(scenario.seededHistory.length).toBeGreaterThanOrEqual(6);
    expect(scenario.expectedOutcome.join(" ")).toContain("2026-10-16");
  });
});

describe("judge seeding", () => {
  it("seeds the fictional history: PAID / PARTIALLY_PAID overdue / SENT invoices, captured order, successful payout, sample dispute", async () => {
    const { client, store } = freshRuntime();
    const result = await seedJudgeScenario(client, store);
    expect(result.alreadySeeded).toBe(false);
    expect(isJudgeSeeded(store)).toBe(true);

    const rows = buildInvoiceRows(await client.listInvoices(), JUDGE_REFERENCE_DATE);
    expect(rows.map((r) => r.status)).toEqual(["SENT", "PARTIALLY_PAID", "PAID"]);
    const [sent, partial, paid] = rows as [typeof rows[0], typeof rows[0], typeof rows[0]];
    expect(sent.recipientName).toBe("Sam Rivera");
    expect(sent.amount).toBe("280.00");
    expect(sent.dueDate).toBe("2026-10-20");
    expect(sent.overdue).toBe(false);
    expect(partial.recipientName).toBe("Marco");
    expect(partial.currency).toBe("EUR");
    expect(partial.amount).toBe("300.00");
    expect(partial.collectedValue).toBe(100);
    expect(partial.overdue).toBe(true); // open + due 2026-10-01 < reference 2026-10-10
    expect(paid.recipientName).toBe("Ana");
    expect(paid.amount).toBe("120.00");

    const orders = await client.listOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe("COMPLETED");
    expect(orders[0]!.purchase_units[0]!.payments?.captures[0]!.status).toBe("COMPLETED");
    expect(orders[0]!.purchase_units[0]!.amount.value).toBe("59.00");

    const payouts = await client.listPayouts();
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.items[0]!.transaction_status).toBe("SUCCESS");
    expect(payouts[0]!.items[0]!.payout_item.amount.value).toBe("80.00");
    expect(payouts[0]!.items[0]!.payout_item.recipient.name).toBe("Marco");

    const disputes = await client.listDisputes();
    expect(disputes).toHaveLength(1);
    expect(disputes[0]!.sample).toBe(true);
  });

  it("leaves the spine plan pending approval with a trigger-gated payout, due Friday 2026-10-16", async () => {
    const { client, store } = freshRuntime();
    const { seed, state } = await seedJudgeScenario(client, store);
    expect(state.spinePlan?.id).toBe(seed.spinePlanId);
    expect(state.spinePlan?.status).toBe("pending_approval");
    expect(state.spinePlan?.steps).toHaveLength(2);
    const [invoiceStep, payoutStep] = state.spinePlan!.steps;
    expect(invoiceStep!.type).toBe("create_invoice");
    expect(invoiceStep!.paypalCall.path).toContain("/v2/invoicing/invoices");
    expect((invoiceStep!.payload as { dueDate?: string }).dueDate).toBe("2026-10-16");
    expect(payoutStep!.type).toBe("draft_payout");
    expect(payoutStep!.trigger?.on).toBe("INVOICING.INVOICE.PAID");
    // Nothing has executed: no spine invoice exists yet.
    expect(state.spineInvoice).toBeNull();
    expect(state.counts).toEqual({ invoices: 3, orders: 1, payouts: 1, plans: 1 });
  });

  it("is idempotent — a second seed changes nothing", async () => {
    const { client, store } = freshRuntime();
    const first = await seedJudgeScenario(client, store);
    const second = await seedJudgeScenario(client, store);
    expect(second.alreadySeeded).toBe(true);
    expect(second.seed.spinePlanId).toBe(first.seed.spinePlanId);
    expect(await client.listInvoices()).toHaveLength(3);
    expect(await client.listOrders()).toHaveLength(1);
    expect(await client.listPayouts()).toHaveLength(1);
    expect(store.listPlans()).toHaveLength(1);
  });

  it("pre-processes historical events so a post-seed sync cannot replay them into the gated payout", async () => {
    const { client, store } = freshRuntime();
    const { seed } = await seedJudgeScenario(client, store);
    // Historical emitted events: invoice paid, capture completed, payout succeeded.
    expect(seed.preProcessedEventIds.length).toBe(3);
    for (const id of seed.preProcessedEventIds) {
      expect(store.hasProcessedEvent(id)).toBe(true);
    }
    const sync = await syncFromPayPal(store, client);
    expect(sync.processedEventIds).toEqual([]);
    expect(sync.alreadyProcessedEventIds).toEqual(expect.arrayContaining(seed.preProcessedEventIds));
    expect(sync.resumed).toEqual([]);
    expect(store.getPlan(seed.spinePlanId)?.status).toBe("pending_approval");
  });
});

describe("judge payment leg — the full loop", () => {
  it("refuses to simulate payment before the scenario is seeded", async () => {
    const { client, store } = freshRuntime();
    await expect(simulateJudgeInvoicePayment(client, store)).rejects.toBeInstanceOf(JudgeModeError);
  });

  it("refuses to simulate payment before the spine plan is executed", async () => {
    const { client, store } = freshRuntime();
    await seedJudgeScenario(client, store);
    await expect(simulateJudgeInvoicePayment(client, store)).rejects.toThrow(/approve and execute/);
  });

  it("closes the loop: approve → execute → pay → gated payout resumes → plan completed", async () => {
    const { client, store } = freshRuntime();
    const { seed } = await seedJudgeScenario(client, store);

    store.approvePlan(seed.spinePlanId);
    const executed = await executePlan(store, client, seed.spinePlanId);
    expect(executed.plan.status).toBe("awaiting_trigger");

    const midState = await getJudgeState(store, client);
    expect(midState.spineInvoice?.status).toBe("SENT");
    expect(midState.spineInvoice?.amount).toBe("450.00");

    const payment = await simulateJudgeInvoicePayment(client, store);
    expect(payment.alreadyPaid).toBe(false);
    expect(payment.invoice.status).toBe("PAID");
    expect(payment.sync?.resumed.map((r) => r.plan.id)).toEqual([seed.spinePlanId]);
    expect(payment.spinePlanStatus).toBe("completed");

    // Money trace: +450 invoice payment, -200 gated payout, on top of history.
    const txns = await client.listTransactions();
    const amounts = txns.map((t) => t.transaction_amount.value);
    expect(amounts).toContain("450.00");
    expect(amounts).toContain("-200.00");

    const payouts = await client.listPayouts();
    expect(payouts).toHaveLength(2); // seeded USD 80 history + USD 200 spine payout
    const spinePayout = payouts.find((p) => p.items[0]!.payout_item.amount.value === "200.00");
    expect(spinePayout?.items[0]!.transaction_status).toBe("SUCCESS");
    expect(spinePayout?.items[0]!.payout_item.recipient.name).toBe("Marco");
  });

  it("a second payment simulation is an honest no-op — no double payout", async () => {
    const { client, store } = freshRuntime();
    const { seed } = await seedJudgeScenario(client, store);
    store.approvePlan(seed.spinePlanId);
    await executePlan(store, client, seed.spinePlanId);
    await simulateJudgeInvoicePayment(client, store);

    const again = await simulateJudgeInvoicePayment(client, store);
    expect(again.alreadyPaid).toBe(true);
    expect(again.sync).toBeNull();
    expect(again.spinePlanStatus).toBe("completed");
    expect(await client.listPayouts()).toHaveLength(2);
  });
});
