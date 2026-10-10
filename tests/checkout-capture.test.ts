import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { PayPalError, type PayPalClient } from "../src/lib/paypal/client";
import { LedgerStore } from "../src/lib/agent/store";
import { parseBrief } from "../src/lib/agent/parser";
import { executePlan } from "../src/lib/agent/executor";
import { buildOrderRows, computeSummary } from "../src/lib/console/read-models";
import { CheckoutError, captureCheckoutOrder } from "../src/lib/checkout";
import { seedJudgeScenario } from "../src/lib/judge";
import type { Order } from "../src/lib/types";

function freshRuntime() {
  return { client: new MockPayPalClient(), store: new LedgerStore() };
}

/** Execute an approved sell brief; returns the created order's id. */
async function sellOrder(client: MockPayPalClient, store: LedgerStore, brief = "Sell a logo pack for $75"): Promise<string> {
  const plan = store.addPlan(parseBrief(brief));
  store.approvePlan(plan.id);
  const result = await executePlan(store, client, plan.id);
  expect(result.plan.status).toBe("completed");
  const orders = await client.listOrders();
  expect(orders).toHaveLength(1);
  return orders[0]!.id;
}

describe("checkout capture leg — the sell loop closes", () => {
  it("an agent-created order sits CREATED until the buyer-side capture completes it", async () => {
    const { client, store } = freshRuntime();
    const orderId = await sellOrder(client, store);

    // Before capture: CREATED, no capture, nothing in captured totals.
    let rows = buildOrderRows(await client.listOrders());
    expect(rows[0]).toMatchObject({ id: orderId, status: "CREATED", captured: false, captureId: "" });
    let summary = computeSummary({
      invoices: [], orders: await client.listOrders(), payouts: [], disputes: [],
      plans: store.listPlans(), activity: store.listActivity(), referenceDate: "2026-10-10",
    });
    expect(summary.capturedOrders).toEqual([]);

    const result = await captureCheckoutOrder(client, store, orderId);
    expect(result.alreadyCaptured).toBe(false);
    expect(result.order.status).toBe("COMPLETED");
    expect(result.order.captureStatus).toBe("COMPLETED");
    expect(result.order.captureId).toMatch(/^CAP-/);
    expect(result.order.amount).toBe("75.00");

    // The capture event was processed exactly once through the reconciler.
    expect(result.sync).not.toBeNull();
    expect(result.sync!.processedEventIds).toHaveLength(1);
    const activity = store.listActivity();
    const syncRow = activity.find((a) => a.summary.includes("PAYMENT.CAPTURE.COMPLETED"));
    expect(syncRow?.detail?.eventId).toBe(result.sync!.processedEventIds[0]);

    // Console projections + ledger now show the money in.
    rows = buildOrderRows(await client.listOrders());
    expect(rows[0]).toMatchObject({ status: "COMPLETED", captured: true, captureId: result.order.captureId });
    summary = computeSummary({
      invoices: [], orders: await client.listOrders(), payouts: [], disputes: [],
      transactions: await client.listTransactions(),
      plans: store.listPlans(), activity: store.listActivity(), referenceDate: "2026-10-10",
    });
    expect(summary.capturedOrders).toEqual([{ currency_code: "USD", value: "75.00" }]);
    const txns = await client.listTransactions();
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ transaction_id: result.order.captureId, transaction_amount: { currency_code: "USD", value: "75.00" } });

    // The audit trail carries the exact capture call.
    const captureRow = activity.find((a) => a.kind === "paypal_call" && a.summary.includes("/capture"));
    expect(captureRow?.summary).toContain(`POST /v2/checkout/orders/${orderId}/capture`);
    expect(captureRow?.detail).toMatchObject({ orderId, captured: true });
  });

  it("a second capture is an alreadyCaptured no-op — no second capture, transaction, or audit call", async () => {
    const { client, store } = freshRuntime();
    const orderId = await sellOrder(client, store);
    await captureCheckoutOrder(client, store, orderId);
    const callsBefore = store.listActivity().filter((a) => a.kind === "paypal_call").length;

    const again = await captureCheckoutOrder(client, store, orderId);
    expect(again.alreadyCaptured).toBe(true);
    expect(again.sync).toBeNull();
    expect(again.order.status).toBe("COMPLETED");
    expect(await client.listTransactions()).toHaveLength(1);
    expect(store.listActivity().filter((a) => a.kind === "paypal_call")).toHaveLength(callsBefore);
  });

  it("Judge Mode's seeded (already captured) order is an alreadyCaptured no-op", async () => {
    const { client, store } = freshRuntime();
    const seeded = await seedJudgeScenario(client, store);
    const result = await captureCheckoutOrder(client, store, seeded.seed.orderId);
    expect(result.alreadyCaptured).toBe(true);
    expect(result.order.amount).toBe("59.00");
  });

  it("an unknown order id is a 404 CheckoutError and captures nothing", async () => {
    const { client, store } = freshRuntime();
    await expect(captureCheckoutOrder(client, store, "ORDER-999999")).rejects.toMatchObject({
      name: "CheckoutError",
      status: 404,
    });
    await expect(captureCheckoutOrder(client, store, "ORDER-999999")).rejects.toBeInstanceOf(CheckoutError);
    expect(await client.listOrders()).toHaveLength(0);
  });
});

describe("checkout capture leg — refusal paths", () => {
  const voidedOrder: Order = {
    id: "ORDER-VOIDED-1",
    status: "VOIDED",
    intent: "CAPTURE",
    purchase_units: [{ description: "Voided sale", amount: { currency_code: "USD", value: "10.00" } }],
    links: [],
  };
  const createdOrder: Order = { ...voidedOrder, id: "ORDER-CREATED-1", status: "CREATED" };

  function stubClient(order: Order, captureImpl: () => Promise<Order>): PayPalClient {
    return {
      mode: "mock",
      listOrders: async () => [structuredClone(order)],
      captureOrder: captureImpl,
    } as unknown as PayPalClient;
  }

  it("a VOIDED order is a 409 and the adapter's capture is never called", async () => {
    const store = new LedgerStore();
    let captureCalls = 0;
    const client = stubClient(voidedOrder, async () => {
      captureCalls += 1;
      throw new Error("must not be called");
    });
    await expect(captureCheckoutOrder(client, store, voidedOrder.id)).rejects.toMatchObject({
      name: "CheckoutError",
      status: 409,
    });
    expect(captureCalls).toBe(0);
  });

  it("an adapter refusal (sandbox: buyer has not approved yet) propagates and is audit-logged as a failure", async () => {
    const store = new LedgerStore();
    const client = stubClient(createdOrder, async () => {
      throw new PayPalError("Order ORDER-CREATED-1 has not been approved by the buyer", 422, "UNPROCESSABLE_ENTITY");
    });
    await expect(captureCheckoutOrder(client, store, createdOrder.id)).rejects.toMatchObject({
      name: "PayPalError",
      status: 422,
    });
    const failures = store.listActivity().filter((a) => a.kind === "system" && a.summary.includes("capture"));
    expect(failures).toHaveLength(1);
    expect(failures[0]!.summary).toContain("has not been approved");
    expect(failures[0]!.detail).toMatchObject({ orderId: createdOrder.id, captured: false });
    // No paypal_call success row was written for the refused capture.
    expect(store.listActivity().filter((a) => a.kind === "paypal_call")).toHaveLength(0);
  });
});
