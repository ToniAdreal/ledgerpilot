/**
 * Mock adapter money validation — the adapter's own boundary.
 *
 * Every app surface (parser, drafts, LLM validator, forms,
 * record-payment leg) already refuses non-positive / non-finite
 * amounts, but the mock adapter — the demo's PayPal stand-in —
 * trusted its inputs: its payout check `Number(value) <= 0` let a
 * non-numeric amount through (NaN comparisons are false), invoice
 * totals summed to "NaN" or went negative, a negative recorded
 * payment increased the amount due, and an overpayment was
 * silently clamped. These tests pin the adapter-level rules:
 * amounts and quantities finite and positive, a recorded payment
 * in the invoice's currency and never above the amount due, and
 * every refusal leaving state untouched.
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

async function openInvoice(c: MockPayPalClient, value = "100.00", currency: "USD" | "EUR" = "USD") {
  const draft = await c.createInvoice({
    recipient: ANA,
    items: [{ name: "Logo work", quantity: "1", unit_amount: { currency_code: currency, value } }],
  });
  return c.sendInvoice(draft.id);
}

describe("mock payout amount validation", () => {
  it.each(["abc", "", "NaN", "Infinity", "0.00", "-5.00"])(
    "refuses a payout amount of %j with a 400 and creates nothing",
    async (value) => {
      const c = client();
      await expect(
        c.createPayout({ items: [{ recipient: MARCO, amount: { currency_code: "USD", value } }] }),
      ).rejects.toMatchObject({ status: 400, name_: "VALIDATION_ERROR" });
      await expect(
        c.createPayout({ items: [{ recipient: MARCO, amount: { currency_code: "USD", value } }] }),
      ).rejects.toBeInstanceOf(PayPalError);
      expect(await c.listPayouts()).toEqual([]);
      expect(await c.listTransactions()).toEqual([]);
      expect(c.emittedEvents).toEqual([]);
    },
  );

  it("still pays out a valid batch exactly as before", async () => {
    const c = client();
    const batch = await c.createPayout({
      items: [{ recipient: MARCO, amount: { currency_code: "USD", value: "200.00" } }],
    });
    expect(batch.batch_header.batch_status).toBe("SUCCESS");
    expect((await c.listTransactions()).map((t) => t.transaction_amount.value)).toEqual(["-200.00"]);
  });
});

describe("mock invoice money validation", () => {
  it.each(["abc", "NaN", "Infinity", "0.00", "-10.00"])(
    "refuses a unit amount of %j and creates no invoice",
    async (value) => {
      const c = client();
      await expect(
        c.createInvoice({
          recipient: ANA,
          items: [{ name: "Logo work", quantity: "1", unit_amount: { currency_code: "USD", value } }],
        }),
      ).rejects.toMatchObject({ status: 400, name_: "VALIDATION_ERROR" });
      expect(await c.listInvoices()).toEqual([]);
    },
  );

  it.each(["abc", "NaN", "0", "-2"])("refuses a quantity of %j and creates no invoice", async (quantity) => {
    const c = client();
    await expect(
      c.createInvoice({
        recipient: ANA,
        items: [{ name: "Logo work", quantity, unit_amount: { currency_code: "USD", value: "10.00" } }],
      }),
    ).rejects.toMatchObject({ status: 400, name_: "VALIDATION_ERROR" });
    expect(await c.listInvoices()).toEqual([]);
  });

  it("refuses an invoice with no items", async () => {
    const c = client();
    await expect(c.createInvoice({ recipient: ANA, items: [] })).rejects.toMatchObject({ status: 400 });
    expect(await c.listInvoices()).toEqual([]);
  });

  it("keeps fractional quantities: 2.5 hours at 10.00 totals 25.00", async () => {
    const c = client();
    const invoice = await c.createInvoice({
      recipient: ANA,
      items: [{ name: "Consulting hours", quantity: "2.5", unit_amount: { currency_code: "USD", value: "10.00" } }],
    });
    expect(invoice.amount.value).toBe("25.00");
    expect(invoice.due_amount.value).toBe("25.00");
  });
});

describe("mock order amount validation", () => {
  it.each(["abc", "NaN", "Infinity", "0.00", "-5.00"])(
    "refuses an order amount of %j and creates no order",
    async (value) => {
      const c = client();
      await expect(
        c.createOrder({ description: "Logo pack", amount: { currency_code: "USD", value } }),
      ).rejects.toMatchObject({ status: 400, name_: "VALIDATION_ERROR" });
      expect(await c.listOrders()).toEqual([]);
    },
  );

  it("still creates and captures a valid order exactly as before", async () => {
    const c = client();
    const order = await c.createOrder({ description: "Logo pack", amount: { currency_code: "USD", value: "75.00" } });
    const captured = await c.captureOrder(order.id);
    expect(captured.status).toBe("COMPLETED");
    expect((await c.listTransactions()).map((t) => t.transaction_amount.value)).toEqual(["75.00"]);
  });
});

describe("mock recorded-payment validation", () => {
  it.each(["abc", "", "NaN", "Infinity", "0.00", "-50.00"])(
    "refuses a recorded payment of %j with a 422 and leaves the invoice untouched",
    async (value) => {
      const c = client();
      const invoice = await openInvoice(c);
      await expect(
        c.recordInvoicePayment(invoice.id, { value, currency_code: "USD" }),
      ).rejects.toMatchObject({ status: 422, name_: "UNPROCESSABLE_ENTITY" });
      const after = await c.getInvoice(invoice.id);
      expect(after.status).toBe("SENT");
      expect(after.due_amount.value).toBe("100.00");
      expect(await c.listTransactions()).toEqual([]);
      expect(c.emittedEvents).toEqual([]);
    },
  );

  it("refuses an overpayment instead of silently clamping the excess away", async () => {
    const c = client();
    const invoice = await openInvoice(c);
    await expect(
      c.recordInvoicePayment(invoice.id, { value: "150.00", currency_code: "USD" }),
    ).rejects.toMatchObject({ status: 422 });
    const after = await c.getInvoice(invoice.id);
    expect(after.status).toBe("SENT");
    expect(after.due_amount.value).toBe("100.00");
    expect(await c.listTransactions()).toEqual([]);
  });

  it("refuses a payment in a different currency than the invoice's", async () => {
    const c = client();
    const invoice = await openInvoice(c, "100.00", "EUR");
    await expect(
      c.recordInvoicePayment(invoice.id, { value: "40.00", currency_code: "USD" }),
    ).rejects.toMatchObject({ status: 422 });
    const after = await c.getInvoice(invoice.id);
    expect(after.status).toBe("SENT");
    expect(after.due_amount.value).toBe("100.00");
  });

  it("still records partial then full payments exactly as before", async () => {
    const c = client();
    const invoice = await openInvoice(c);
    const partial = await c.recordInvoicePayment(invoice.id, { value: "40.00", currency_code: "USD" });
    expect(partial.status).toBe("PARTIALLY_PAID");
    expect(partial.due_amount.value).toBe("60.00");
    const paid = await c.recordInvoicePayment(invoice.id, { value: "60.00", currency_code: "USD" });
    expect(paid.status).toBe("PAID");
    expect(paid.due_amount.value).toBe("0.00");
    expect((await c.listTransactions()).map((t) => t.transaction_amount.value)).toEqual(["100.00"]);
    expect(c.emittedEvents.map((e) => e.event_type)).toEqual(["INVOICING.INVOICE.PAID"]);
  });

  it("a refusal after a partial payment leaves the recorded partial intact", async () => {
    const c = client();
    const invoice = await openInvoice(c);
    await c.recordInvoicePayment(invoice.id, { value: "40.00", currency_code: "USD" });
    await expect(
      c.recordInvoicePayment(invoice.id, { value: "999.00", currency_code: "USD" }),
    ).rejects.toMatchObject({ status: 422 });
    const after = await c.getInvoice(invoice.id);
    expect(after.status).toBe("PARTIALLY_PAID");
    expect(after.due_amount.value).toBe("60.00");
  });
});
