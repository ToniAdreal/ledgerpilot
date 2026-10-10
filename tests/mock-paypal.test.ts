import { describe, expect, it } from "vitest";
import {
  MockPayPalClient,
  PayPalError,
  PayPalNotConfiguredError,
  SandboxPayPalClient,
  getPayPalClient,
  mockTransmissionSig,
} from "@/lib/paypal";
import type { WebhookEvent } from "@/lib/types";

const ANA = { name: "Ana", email_address: "ana@example.com" };
const MARCO = { name: "Marco", email_address: "marco@example.com" };

async function paidInvoice(client: MockPayPalClient) {
  const draft = await client.createInvoice({
    recipient: ANA,
    items: [{ name: "Logo work", quantity: "1", unit_amount: { currency_code: "USD", value: "450.00" } }],
    dueDate: "2026-10-16",
  });
  await client.sendInvoice(draft.id);
  return client.recordInvoicePayment(draft.id, { value: "450.00", currency_code: "USD" });
}

describe("mock invoicing", () => {
  it("creates a DRAFT with a summed total, then sends it", async () => {
    const client = new MockPayPalClient();
    const draft = await client.createInvoice({
      recipient: ANA,
      items: [
        { name: "Logo work", quantity: "1", unit_amount: { currency_code: "USD", value: "300.00" } },
        { name: "Revisions", quantity: "2", unit_amount: { currency_code: "USD", value: "75.00" } },
      ],
    });
    expect(draft.status).toBe("DRAFT");
    expect(draft.amount).toEqual({ currency_code: "USD", value: "450.00" });
    const sent = await client.sendInvoice(draft.id);
    expect(sent.status).toBe("SENT");
  });

  it("rejects sending a non-draft and paying twice", async () => {
    const client = new MockPayPalClient();
    const paid = await paidInvoice(client);
    expect(paid.status).toBe("PAID");
    expect(paid.due_amount.value).toBe("0.00");
    await expect(client.sendInvoice(paid.id)).rejects.toBeInstanceOf(PayPalError);
    await expect(
      client.recordInvoicePayment(paid.id, { value: "1.00", currency_code: "USD" }),
    ).rejects.toBeInstanceOf(PayPalError);
  });

  it("supports partial payment, then emits INVOICING.INVOICE.PAID and a transaction on full payment", async () => {
    const client = new MockPayPalClient();
    const draft = await client.createInvoice({
      recipient: ANA,
      items: [{ name: "Brand work", quantity: "1", unit_amount: { currency_code: "USD", value: "450.00" } }],
    });
    await client.sendInvoice(draft.id);
    const partial = await client.recordInvoicePayment(draft.id, { value: "200.00", currency_code: "USD" });
    expect(partial.status).toBe("PARTIALLY_PAID");
    expect(partial.due_amount.value).toBe("250.00");
    expect(client.emittedEvents).toHaveLength(0);

    await client.recordInvoicePayment(draft.id, { value: "250.00", currency_code: "USD" });
    expect(client.emittedEvents.map((e) => e.event_type)).toEqual(["INVOICING.INVOICE.PAID"]);
    const txns = await client.listTransactions();
    expect(txns).toHaveLength(1);
    expect(txns[0]?.transaction_amount.value).toBe("450.00");
  });

  it("404s on an unknown invoice", async () => {
    const client = new MockPayPalClient();
    await expect(client.getInvoice("INV2-999999")).rejects.toMatchObject({ status: 404 });
  });
});

describe("mock orders", () => {
  it("creates and captures an order, emitting PAYMENT.CAPTURE.COMPLETED", async () => {
    const client = new MockPayPalClient();
    const order = await client.createOrder({
      description: "Studio cable pack",
      amount: { currency_code: "USD", value: "59.00" },
    });
    expect(order.status).toBe("CREATED");
    const captured = await client.captureOrder(order.id);
    expect(captured.status).toBe("COMPLETED");
    expect(captured.purchase_units[0]?.payments?.captures[0]?.status).toBe("COMPLETED");
    expect(client.emittedEvents.map((e) => e.event_type)).toEqual(["PAYMENT.CAPTURE.COMPLETED"]);
    await expect(client.captureOrder(order.id)).rejects.toBeInstanceOf(PayPalError);
  });
});

describe("mock payouts", () => {
  it("pays out a batch and closes the demo loop after an invoice is paid", async () => {
    const client = new MockPayPalClient();
    await paidInvoice(client);
    const batch = await client.createPayout({
      items: [{ recipient: MARCO, amount: { currency_code: "USD", value: "200.00" }, note: "Contractor share of Ana invoice" }],
    });
    expect(batch.batch_header.batch_status).toBe("SUCCESS");
    expect(batch.items[0]?.transaction_status).toBe("SUCCESS");
    expect(client.emittedEvents.map((e) => e.event_type)).toEqual([
      "INVOICING.INVOICE.PAID",
      "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
    ]);
    const txns = await client.listTransactions();
    expect(txns.map((t) => t.transaction_amount.value)).toEqual(["450.00", "-200.00"]);
  });

  it("validates payout items", async () => {
    const client = new MockPayPalClient();
    await expect(client.createPayout({ items: [] })).rejects.toBeInstanceOf(PayPalError);
    await expect(
      client.createPayout({ items: [{ recipient: MARCO, amount: { currency_code: "USD", value: "0.00" } }] }),
    ).rejects.toBeInstanceOf(PayPalError);
  });
});

describe("mock read-only surfaces", () => {
  it("returns the sample dispute clearly flagged, and none when seeding is off", async () => {
    const withSample = await new MockPayPalClient().listDisputes();
    expect(withSample).toHaveLength(1);
    expect(withSample[0]?.sample).toBe(true);
    expect(await new MockPayPalClient({ sampleDispute: false }).listDisputes()).toEqual([]);
  });
});

describe("mock webhook verification", () => {
  const event: WebhookEvent = {
    id: "WH-TEST-1",
    create_time: "2026-10-10T00:00:00Z",
    resource_type: "invoice",
    event_type: "INVOICING.INVOICE.PAID",
    summary: "Invoice was paid",
    resource: { id: "INV2-000001" },
    event_version: "1.0",
    resource_version: "2.0",
  };

  it("accepts a correctly signed event and rejects tampered or unsigned ones", async () => {
    const client = new MockPayPalClient();
    const headers = {
      "paypal-transmission-id": "transmission-1",
      "paypal-transmission-sig": mockTransmissionSig("transmission-1", event.id),
    };
    await expect(client.verifyWebhookSignature(headers, event)).resolves.toBe(true);
    await expect(
      client.verifyWebhookSignature({ ...headers, "paypal-transmission-sig": "deadbeef" }, event),
    ).resolves.toBe(false);
    await expect(client.verifyWebhookSignature({}, event)).resolves.toBe(false);
  });
});

describe("adapter factory", () => {
  it("defaults to mock with no env", () => {
    expect(getPayPalClient({}).mode).toBe("mock");
    expect(getPayPalClient({ PAYPAL_MODE: "mock" }).mode).toBe("mock");
  });

  it("requires credentials for sandbox mode and fails loudly without them", () => {
    expect(() => getPayPalClient({ PAYPAL_MODE: "sandbox" })).toThrow(PayPalNotConfiguredError);
    expect(() => new SandboxPayPalClient({ clientId: "x" })).toThrow(/PAYPAL_CLIENT_SECRET/);
    const configured = new SandboxPayPalClient({ clientId: "x", clientSecret: "y" });
    expect(configured.baseUrl).toBe("https://api-m.sandbox.paypal.com");
  });
});
