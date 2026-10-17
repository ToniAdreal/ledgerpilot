/**
 * Mock adapter sub-cent hygiene — the two-decimal boundary at the
 * adapter's own boundary.
 *
 * Every app surface already refuses a sub-cent amount (0.001–0.004:
 * positive as a number, but formats to "0.00") — the drafts
 * validator, the LLM validator, the console forms, and the
 * record-payment leg (tests/sub-cent-amounts.test.ts) — and the
 * mock adapter's money-validation run refused non-finite and
 * non-positive amounts at its own boundary. But the mock's check
 * governed the pre-rounding number, so a direct adapter caller
 * could still: create an invoice whose total formatted to "0.00",
 * capture an order whose transaction carried the verbatim
 * "0.001", pay out a "-0.001" transaction as SUCCESS, record a
 * 0.004 payment that flipped an invoice to PARTIALLY_PAID while
 * the amount due stayed 450.00 (a payment that moved nothing,
 * recorded as progress), and build a "0.00" invoice total from a
 * tiny fractional quantity (0.001 × 1.00). A non-array payout
 * `items` also escaped as a raw TypeError instead of the 400
 * VALIDATION_ERROR every other malformed create gets.
 *
 * These tests pin the adapter-level rule, mirroring the app
 * surfaces exactly: the emitted (two-decimal) value is what is
 * checked and what is stored — a sub-cent amount refuses naming
 * the 0.01 floor, 0.01 is accepted, and 0.005 is accepted as the
 * 0.01 it formats to. Every refusal leaves state untouched.
 */
import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { PayPalError } from "../src/lib/paypal/client";
import type { Party } from "../src/lib/types";

const ANA: Party = { name: "Ana", email_address: "ana@example.com" };
const MARCO: Party = { name: "Marco", email_address: "marco@example.com" };

function client(): MockPayPalClient {
  return new MockPayPalClient({ sampleDispute: false });
}

async function openInvoice(c: MockPayPalClient, value = "450.00") {
  const draft = await c.createInvoice({
    recipient: ANA,
    items: [{ name: "Brand work", quantity: "1", unit_amount: { currency_code: "USD", value } }],
  });
  return c.sendInvoice(draft.id);
}

describe("mock sub-cent amounts — invoices", () => {
  it.each(["0.001", "0.004"])(
    "refuses a unit amount of %s with a 400 naming the 0.01 floor, and creates no invoice",
    async (value) => {
      const c = client();
      await expect(
        c.createInvoice({
          recipient: ANA,
          items: [{ name: "Brand work", quantity: "1", unit_amount: { currency_code: "USD", value } }],
        }),
      ).rejects.toMatchObject({ status: 400, name_: "VALIDATION_ERROR" });
      await expect(
        c.createInvoice({
          recipient: ANA,
          items: [{ name: "Brand work", quantity: "1", unit_amount: { currency_code: "USD", value } }],
        }),
      ).rejects.toThrow(/at least 0\.01/);
      expect(await c.listInvoices()).toEqual([]);
    },
  );

  it("refuses an invoice whose total rounds to 0.00 via a tiny fractional quantity", async () => {
    const c = client();
    await expect(
      c.createInvoice({
        recipient: ANA,
        items: [{ name: "Sliver of an hour", quantity: "0.001", unit_amount: { currency_code: "USD", value: "1.00" } }],
      }),
    ).rejects.toMatchObject({ status: 400, name_: "VALIDATION_ERROR" });
    await expect(
      c.createInvoice({
        recipient: ANA,
        items: [{ name: "Sliver of an hour", quantity: "0.4", unit_amount: { currency_code: "USD", value: "0.01" } }],
      }),
    ).rejects.toThrow(/total/i);
    expect(await c.listInvoices()).toEqual([]);
  });

  it("accepts the boundary: unit 0.01 totals 0.01, and 0.005 is stored as the 0.01 it formats to", async () => {
    const c = client();
    const cent = await c.createInvoice({
      recipient: ANA,
      items: [{ name: "One cent", quantity: "1", unit_amount: { currency_code: "USD", value: "0.01" } }],
    });
    expect(cent.amount.value).toBe("0.01");
    const halfCent = await c.createInvoice({
      recipient: ANA,
      items: [{ name: "Half cent", quantity: "1", unit_amount: { currency_code: "USD", value: "0.005" } }],
    });
    expect(halfCent.items[0]!.unit_amount.value).toBe("0.01");
    expect(halfCent.amount.value).toBe("0.01");
  });
});

describe("mock sub-cent amounts — orders", () => {
  it.each(["0.001", "0.004"])("refuses an order amount of %s and creates no order", async (value) => {
    const c = client();
    await expect(
      c.createOrder({ description: "Logo pack", amount: { currency_code: "USD", value } }),
    ).rejects.toMatchObject({ status: 400, name_: "VALIDATION_ERROR" });
    await expect(
      c.createOrder({ description: "Logo pack", amount: { currency_code: "USD", value } }),
    ).rejects.toThrow(/at least 0\.01/);
    expect(await c.listOrders()).toEqual([]);
    expect(await c.listTransactions()).toEqual([]);
  });

  it("stores the emitted value: an order of 0.005 is a 0.01 order and captures as 0.01", async () => {
    const c = client();
    const order = await c.createOrder({ description: "Half cent pack", amount: { currency_code: "USD", value: "0.005" } });
    expect(order.purchase_units[0]!.amount.value).toBe("0.01");
    const captured = await c.captureOrder(order.id);
    expect(captured.purchase_units[0]!.payments!.captures![0]!.amount.value).toBe("0.01");
    expect((await c.listTransactions()).map((t) => t.transaction_amount.value)).toEqual(["0.01"]);
  });
});

describe("mock sub-cent amounts — payouts", () => {
  it.each(["0.001", "0.004"])(
    "refuses a payout item amount of %s and creates no batch, transaction, or event",
    async (value) => {
      const c = client();
      await expect(
        c.createPayout({ items: [{ recipient: MARCO, amount: { currency_code: "USD", value } }] }),
      ).rejects.toMatchObject({ status: 400, name_: "VALIDATION_ERROR" });
      await expect(
        c.createPayout({ items: [{ recipient: MARCO, amount: { currency_code: "USD", value } }] }),
      ).rejects.toThrow(/at least 0\.01/);
      expect(await c.listPayouts()).toEqual([]);
      expect(await c.listTransactions()).toEqual([]);
      expect(c.emittedEvents).toEqual([]);
    },
  );

  it("refuses a batch whose second line is sub-cent, creating nothing (validation precedes any state change)", async () => {
    const c = client();
    await expect(
      c.createPayout({
        items: [
          { recipient: MARCO, amount: { currency_code: "USD", value: "200.00" } },
          { recipient: ANA, amount: { currency_code: "USD", value: "0.002" } },
        ],
      }),
    ).rejects.toBeInstanceOf(PayPalError);
    expect(await c.listPayouts()).toEqual([]);
    expect(await c.listTransactions()).toEqual([]);
  });

  it("stores the emitted value: a payout of 0.005 pays out 0.01 with a -0.01 transaction", async () => {
    const c = client();
    const batch = await c.createPayout({
      items: [{ recipient: MARCO, amount: { currency_code: "USD", value: "0.005" } }],
    });
    expect(batch.items[0]!.payout_item.amount.value).toBe("0.01");
    expect((await c.listTransactions()).map((t) => t.transaction_amount.value)).toEqual(["-0.01"]);
  });

  it("refuses a non-array items value as a 400 VALIDATION_ERROR, never a raw TypeError", async () => {
    const c = client();
    await expect(c.createPayout({ items: undefined as never })).rejects.toMatchObject({
      status: 400,
      name_: "VALIDATION_ERROR",
    });
    await expect(c.createPayout({ items: "nope" as never })).rejects.toBeInstanceOf(PayPalError);
    expect(await c.listPayouts()).toEqual([]);
  });
});

describe("mock sub-cent amounts — recorded payments", () => {
  it.each(["0.001", "0.004"])(
    "refuses a recorded payment of %s with a 422 naming the floor — the invoice stays SENT with its full amount due",
    async (value) => {
      const c = client();
      const invoice = await openInvoice(c);
      await expect(
        c.recordInvoicePayment(invoice.id, { value, currency_code: "USD" }),
      ).rejects.toMatchObject({ status: 422, name_: "UNPROCESSABLE_ENTITY" });
      await expect(
        c.recordInvoicePayment(invoice.id, { value, currency_code: "USD" }),
      ).rejects.toThrow(/at least 0\.01/);
      const after = await c.getInvoice(invoice.id);
      // The pre-fix behaviour flipped the invoice to PARTIALLY_PAID
      // here while the due amount stayed 450.00 after rounding.
      expect(after.status).toBe("SENT");
      expect(after.due_amount.value).toBe("450.00");
      expect(await c.listTransactions()).toEqual([]);
      expect(c.emittedEvents).toEqual([]);
    },
  );

  it("records the emitted value: a 0.005 payment against a 0.01 invoice pays it in full", async () => {
    const c = client();
    const invoice = await openInvoice(c, "0.01");
    const paid = await c.recordInvoicePayment(invoice.id, { value: "0.005", currency_code: "USD" });
    expect(paid.status).toBe("PAID");
    expect(paid.due_amount.value).toBe("0.00");
    expect((await c.listTransactions()).map((t) => t.transaction_amount.value)).toEqual(["0.01"]);
    expect(c.emittedEvents.map((e) => e.event_type)).toEqual(["INVOICING.INVOICE.PAID"]);
  });

  it("still records ordinary partial and full payments exactly as before", async () => {
    const c = client();
    const invoice = await openInvoice(c);
    const partial = await c.recordInvoicePayment(invoice.id, { value: "200.00", currency_code: "USD" });
    expect(partial.status).toBe("PARTIALLY_PAID");
    expect(partial.due_amount.value).toBe("250.00");
    const paid = await c.recordInvoicePayment(invoice.id, { value: "250.00", currency_code: "USD" });
    expect(paid.status).toBe("PAID");
    expect(paid.due_amount.value).toBe("0.00");
  });
});
