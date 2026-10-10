import { createHash } from "node:crypto";
import type {
  CreateInvoiceInput,
  CreateOrderInput,
  CreatePayoutInput,
  Dispute,
  Invoice,
  Money,
  Order,
  PayoutBatch,
  Transaction,
  WebhookEvent,
} from "../types";
import { PayPalError, type PayPalClient } from "./client";

/**
 * Mock PayPal adapter — PAYPAL_MODE=mock (the October default).
 *
 * Implements the full LedgerPilot PayPal surface against in-memory state
 * seeded with fictional demo data, using resource shapes aligned with the
 * real REST APIs. No credentials, no network.
 *
 * Mock webhook signature scheme: a caller proves an event is authentic by
 * sending header `paypal-transmission-sig` = sha256 hex of
 * `${transmissionId}|${event.id}|${MOCK_WEBHOOK_SECRET}`. This mirrors the
 * shape of PayPal's verify-webhook-signature flow (headers + raw event in,
 * boolean out) without pretending to be real PayPal cryptography.
 */
export const MOCK_WEBHOOK_SECRET = "ledgerpilot-mock-webhook-secret";
export const MOCK_SELLER = { name: "LedgerPilot Demo Seller", email_address: "seller@ledgerpilot.example" };

export function mockTransmissionSig(transmissionId: string, eventId: string): string {
  return createHash("sha256").update(`${transmissionId}|${eventId}|${MOCK_WEBHOOK_SECRET}`).digest("hex");
}

function sumMoney(items: Array<{ quantity: string; unit_amount: Money }>): Money {
  const currency = items[0]?.unit_amount.currency_code ?? "USD";
  const total = items.reduce(
    (acc, i) => acc + Number(i.quantity) * Number(i.unit_amount.value),
    0,
  );
  return { currency_code: currency, value: total.toFixed(2) };
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${String(seq).padStart(6, "0")}`;
}

export interface MockSeedOptions {
  /** Include the clearly-labeled sample dispute row (Judge Mode). Default true. */
  sampleDispute?: boolean;
}

export class MockPayPalClient implements PayPalClient {
  readonly mode = "mock" as const;
  private invoices = new Map<string, Invoice>();
  private orders = new Map<string, Order>();
  private payouts = new Map<string, PayoutBatch>();
  private transactions: Transaction[] = [];
  private disputes: Dispute[];
  /** Webhook events the mock "PayPal" would have delivered, in order. */
  readonly emittedEvents: WebhookEvent[] = [];

  constructor(seed: MockSeedOptions = {}) {
    this.disputes =
      seed.sampleDispute === false
        ? []
        : [
            {
              dispute_id: "PP-D-SAMPLE-001",
              create_time: "2026-10-08T14:22:00Z",
              update_time: "2026-10-08T14:22:00Z",
              disputed_transactions: [
                {
                  seller_transaction_id: "TXN-SAMPLE-001",
                  buyer: { name: "Sam Rivera", email_address: "sam@example.com" },
                },
              ],
              amount: { currency_code: "USD", value: "120.00" },
              reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
              status: "WAITING_FOR_SELLER_RESPONSE",
              dispute_life_cycle_stage: "INQUIRY",
              response_due_date: "2026-10-29T23:59:59Z",
              sample: true,
            },
          ];
  }

  private emit(event_type: string, summary: string, resource: Record<string, unknown>): void {
    this.emittedEvents.push({
      id: nextId("WH"),
      create_time: new Date().toISOString(),
      resource_type: "mock",
      event_type,
      summary,
      resource,
      event_version: "1.0",
      resource_version: "2.0",
    });
  }

  /* ---------------- Invoicing v2 ---------------- */

  async createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
    const amount = sumMoney(input.items);
    const id = nextId("INV2");
    const invoice: Invoice = {
      id,
      status: "DRAFT",
      detail: {
        invoice_number: `LP-${id.slice(-6)}`,
        note: input.note,
        payment_term: input.dueDate ? { due_date: input.dueDate } : undefined,
        reference: input.reference,
      },
      invoicer: MOCK_SELLER,
      primary_recipients: [
        { billing_info: { name: input.recipient.name, email_address: input.recipient.email_address } },
      ],
      items: input.items,
      amount,
      due_amount: amount,
      links: [{ href: `mock://paypal/v2/invoicing/invoices/${id}`, rel: "self", method: "GET" }],
    };
    this.invoices.set(id, invoice);
    return structuredClone(invoice);
  }

  async sendInvoice(invoiceId: string): Promise<Invoice> {
    const invoice = this.mustGetInvoice(invoiceId);
    if (invoice.status !== "DRAFT") {
      throw new PayPalError(`Invoice ${invoiceId} cannot be sent from status ${invoice.status}`, 422, "UNPROCESSABLE_ENTITY");
    }
    invoice.status = "SENT";
    return structuredClone(invoice);
  }

  async getInvoice(invoiceId: string): Promise<Invoice> {
    return structuredClone(this.mustGetInvoice(invoiceId));
  }

  async listInvoices(): Promise<Invoice[]> {
    return [...this.invoices.values()].map((i) => structuredClone(i));
  }

  async recordInvoicePayment(
    invoiceId: string,
    amount: { value: string; currency_code: string },
  ): Promise<Invoice> {
    const invoice = this.mustGetInvoice(invoiceId);
    if (invoice.status === "PAID") {
      throw new PayPalError(`Invoice ${invoiceId} is already paid`, 422, "UNPROCESSABLE_ENTITY");
    }
    const paid = Number(amount.value);
    const due = Number(invoice.due_amount.value);
    invoice.due_amount = { ...invoice.due_amount, value: Math.max(0, due - paid).toFixed(2) };
    invoice.status = invoice.due_amount.value === "0.00" ? "PAID" : "PARTIALLY_PAID";
    if (invoice.status === "PAID") {
      const txnId = nextId("TXN");
      this.transactions.push({
        transaction_id: txnId,
        transaction_event_code: "T0006",
        transaction_initiation_date: new Date().toISOString(),
        transaction_amount: { currency_code: invoice.amount.currency_code, value: invoice.amount.value },
        transaction_status: "S",
        transaction_subject: `Payment for invoice ${invoice.detail.invoice_number}`,
        payer_info: {
          email_address: invoice.primary_recipients[0]?.billing_info.email_address,
          name: invoice.primary_recipients[0]?.billing_info.name,
        },
      });
      this.emit("INVOICING.INVOICE.PAID", `Invoice ${invoice.detail.invoice_number} was paid`, {
        id: invoice.id,
        status: "PAID",
        transaction_id: txnId,
      });
    }
    return structuredClone(invoice);
  }

  private mustGetInvoice(id: string): Invoice {
    const invoice = this.invoices.get(id);
    if (!invoice) throw new PayPalError(`Invoice ${id} not found`, 404);
    return invoice;
  }

  /* ---------------- Orders v2 ---------------- */

  async createOrder(input: CreateOrderInput): Promise<Order> {
    const id = nextId("ORDER");
    const order: Order = {
      id,
      status: "CREATED",
      intent: "CAPTURE",
      purchase_units: [
        { reference_id: input.reference_id, description: input.description, amount: input.amount },
      ],
      links: [
        { href: `mock://paypal/v2/checkout/orders/${id}`, rel: "self", method: "GET" },
        { href: `mock://paypal/checkoutnow?token=${id}`, rel: "approve", method: "GET" },
      ],
    };
    this.orders.set(id, order);
    return structuredClone(order);
  }

  async captureOrder(orderId: string): Promise<Order> {
    const order = this.orders.get(orderId);
    if (!order) throw new PayPalError(`Order ${orderId} not found`, 404);
    if (order.status === "COMPLETED") {
      throw new PayPalError(`Order ${orderId} is already captured`, 422, "UNPROCESSABLE_ENTITY");
    }
    order.status = "COMPLETED";
    const unit = order.purchase_units[0]!;
    const captureId = nextId("CAP");
    unit.payments = { captures: [{ id: captureId, status: "COMPLETED", amount: unit.amount }] };
    this.transactions.push({
      transaction_id: captureId,
      transaction_event_code: "T0007",
      transaction_initiation_date: new Date().toISOString(),
      transaction_amount: unit.amount,
      transaction_status: "S",
      transaction_subject: unit.description,
    });
    this.emit("PAYMENT.CAPTURE.COMPLETED", `Capture ${captureId} completed for order ${orderId}`, {
      id: captureId,
      status: "COMPLETED",
      amount: unit.amount,
    });
    return structuredClone(order);
  }

  async listOrders(): Promise<Order[]> {
    return [...this.orders.values()].map((o) => structuredClone(o));
  }

  /* ---------------- Payouts ---------------- */

  async createPayout(input: CreatePayoutInput): Promise<PayoutBatch> {
    if (input.items.length === 0) {
      throw new PayPalError("A payout batch needs at least one item", 400, "VALIDATION_ERROR");
    }
    for (const item of input.items) {
      if (Number(item.amount.value) <= 0) {
        throw new PayPalError("Payout item amounts must be positive", 400, "VALIDATION_ERROR");
      }
    }
    const batchId = nextId("BATCH");
    const batch: PayoutBatch = {
      batch_header: {
        payout_batch_id: batchId,
        batch_status: "SUCCESS",
        time_created: new Date().toISOString(),
        sender_batch_header: {
          sender_batch_id: batchId,
          email_subject: input.emailSubject ?? "You have a payout from LedgerPilot",
          email_message: input.emailMessage,
        },
      },
      items: input.items.map((item, idx) => ({
        payout_item_id: `${batchId}-ITEM-${idx + 1}`,
        transaction_status: "SUCCESS" as const,
        payout_item: { ...item, receiver: item.recipient.email_address },
      })),
      links: [{ href: `mock://paypal/v1/payments/payouts/${batchId}`, rel: "self", method: "GET" }],
    };
    this.payouts.set(batchId, batch);
    for (const item of batch.items) {
      this.transactions.push({
        transaction_id: item.payout_item_id,
        transaction_event_code: "T2001",
        transaction_initiation_date: new Date().toISOString(),
        transaction_amount: {
          currency_code: item.payout_item.amount.currency_code,
          value: `-${item.payout_item.amount.value}`,
        },
        transaction_status: "S",
        transaction_subject: item.payout_item.note ?? "Payout",
        payer_info: { email_address: item.payout_item.receiver, name: item.payout_item.recipient.name },
      });
      this.emit("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", `Payout to ${item.payout_item.receiver} succeeded`, {
        payout_item_id: item.payout_item_id,
        transaction_status: "SUCCESS",
      });
    }
    return structuredClone(batch);
  }

  async listPayouts(): Promise<PayoutBatch[]> {
    return [...this.payouts.values()].map((p) => structuredClone(p));
  }

  /* ---------------- Read-only surfaces ---------------- */

  async listDisputes(): Promise<Dispute[]> {
    return structuredClone(this.disputes);
  }

  async listTransactions(): Promise<Transaction[]> {
    return structuredClone(this.transactions);
  }

  /* ---------------- Webhooks ---------------- */

  async verifyWebhookSignature(
    headers: Record<string, string>,
    event: WebhookEvent,
  ): Promise<boolean> {
    const transmissionId = headers["paypal-transmission-id"];
    const sig = headers["paypal-transmission-sig"];
    if (!transmissionId || !sig) return false;
    return sig === mockTransmissionSig(transmissionId, event.id);
  }
}
