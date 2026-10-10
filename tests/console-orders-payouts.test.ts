import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import {
  buildOrderRows,
  buildPayoutRows,
  computeSummary,
  toOrderRow,
} from "../src/lib/console/read-models";

const ANA = { name: "Ana", email_address: "ana@example.com" };
const MARCO = { name: "Marco", email_address: "marco@example.com" };
const SAM = { name: "Sam Rivera", email_address: "sam@example.com" };

async function ordersFixture() {
  const client = new MockPayPalClient({ sampleDispute: false });
  const o1 = await client.createOrder({
    description: "Logo pack download",
    amount: { currency_code: "USD", value: "75.00" },
    reference_id: "sku-logo-pack",
  });
  const o2 = await client.createOrder({
    description: "Brand workshop seat",
    amount: { currency_code: "EUR", value: "120.00" },
  });
  await client.captureOrder(o2.id);
  return { client, o1, o2 };
}

async function payoutsFixture() {
  const client = new MockPayPalClient({ sampleDispute: false });
  await client.createPayout({
    items: [
      { recipient: MARCO, amount: { currency_code: "USD", value: "200.00" }, note: "Contractor share" },
      { recipient: SAM, amount: { currency_code: "USD", value: "50.00" }, note: "Review fee" },
    ],
  });
  await client.createPayout({
    items: [{ recipient: ANA, amount: { currency_code: "EUR", value: "80.00" }, note: "Refund share" }],
  });
  return client;
}

describe("console order rows", () => {
  it("projects description, amount, capture state; newest first", async () => {
    const { client, o1 } = await ordersFixture();
    const rows = buildOrderRows(await client.listOrders());
    expect(rows).toHaveLength(2);
    // Newest first: captured EUR order, then the still-CREATED USD order.
    expect(rows.map((r) => r.status)).toEqual(["COMPLETED", "CREATED"]);

    const captured = rows[0]!;
    expect(captured.description).toBe("Brand workshop seat");
    expect(captured.currency).toBe("EUR");
    expect(captured.amount).toBe("120.00");
    expect(captured.amountValue).toBe(120);
    expect(captured.captured).toBe(true);
    expect(captured.captureId).toMatch(/^CAP-/);
    expect(captured.captureStatus).toBe("COMPLETED");

    const created = rows[1]!;
    expect(created.id).toBe(o1.id);
    expect(created.referenceId).toBe("sku-logo-pack");
    expect(created.captured).toBe(false);
    expect(created.captureId).toBe("");
    expect(created.captureStatus).toBe("");
  });

  it("toOrderRow handles an order with no purchase units gracefully", () => {
    const row = toOrderRow({
      id: "ORDER-EMPTY",
      status: "CREATED",
      intent: "CAPTURE",
      purchase_units: [],
      links: [],
    });
    expect(row.description).toBe("");
    expect(row.amount).toBe("0.00");
    expect(row.captured).toBe(false);
  });

  it("empty orders list yields no rows", () => {
    expect(buildOrderRows([])).toEqual([]);
  });
});

describe("console payout rows", () => {
  it("flattens batches to one row per item, newest batch first", async () => {
    const client = await payoutsFixture();
    const rows = buildPayoutRows(await client.listPayouts());
    expect(rows).toHaveLength(3);
    // Newest batch (EUR 80 to Ana) first, then the two USD items in reverse order.
    expect(rows[0]).toMatchObject({
      recipientName: "Ana",
      recipientEmail: "ana@example.com",
      currency: "EUR",
      amount: "80.00",
      amountValue: 80,
      status: "SUCCESS",
      batchStatus: "SUCCESS",
      note: "Refund share",
    });
    expect(rows[0]!.batchId).toMatch(/^BATCH-/);
    expect(rows[0]!.timeCreated).toBeTruthy();

    const usd = rows.slice(1);
    expect(usd.map((r) => r.amount).sort()).toEqual(["200.00", "50.00"]);
    expect(usd.every((r) => r.batchId === usd[0]!.batchId)).toBe(true);
    expect(usd.map((r) => r.recipientName).sort()).toEqual(["Marco", "Sam Rivera"]);
  });

  it("empty payouts list yields no rows", () => {
    expect(buildPayoutRows([])).toEqual([]);
  });
});

describe("console summary — orders / payouts totals", () => {
  it("capturedOrders counts COMPLETED only and payoutsSent counts SUCCESS, per currency", async () => {
    const { client: orderClient } = await ordersFixture();
    const payoutClient = await payoutsFixture();
    const summary = computeSummary({
      invoices: [],
      orders: await orderClient.listOrders(),
      payouts: await payoutClient.listPayouts(),
      disputes: [],
      plans: [],
      activity: [],
      referenceDate: "2026-10-10",
    });
    // Only the captured EUR 120 order counts; the CREATED USD 75 order does not.
    expect(summary.capturedOrders).toEqual([{ currency_code: "EUR", value: "120.00" }]);
    // USD 200 + 50 across items in one batch, EUR 80 in the other — never cross-summed.
    expect(summary.payoutsSent).toEqual([
      { currency_code: "EUR", value: "80.00" },
      { currency_code: "USD", value: "250.00" },
    ]);
    expect(summary.counts.orders).toBe(2);
    expect(summary.counts.payouts).toBe(2);
  });

  it("empty state yields empty order / payout totals", () => {
    const summary = computeSummary({
      invoices: [],
      orders: [],
      payouts: [],
      disputes: [],
      plans: [],
      activity: [],
      referenceDate: "2026-10-10",
    });
    expect(summary.capturedOrders).toEqual([]);
    expect(summary.payoutsSent).toEqual([]);
  });
});
