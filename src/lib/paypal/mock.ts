import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  CreateInvoiceInput,
  CreateOrderInput,
  CreatePayoutInput,
  Dispute,
  Invoice,
  Money,
  Order,
  PayoutBatch,
  SendInvoiceReminderInput,
  SentInvoiceReminder,
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
 *
 * Persistence (opt-in): by default the mock is purely in-memory. When a
 * file path is supplied (constructor option, or the
 * `PAYPAL_MOCK_STORE_FILE` env var through the client factory), every
 * mutation is written through to that file as a versioned JSON snapshot
 * (sibling temp file + atomic rename), so a restarted instance restores
 * its invoices, orders, payout batches, transactions, disputes,
 * emitted events, sent reminders, and the id sequence. This is the
 * mock-mode companion to the ledger store's `LEDGERPILOT_STORE_FILE`:
 * with both set, a mock-mode restart loses nothing. It is NOT a
 * multi-writer store — one server process per file. A corrupt or
 * unsupported snapshot fails loudly (`MockPayPalPersistenceError`)
 * instead of silently reseeding demo state over real mock history.
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

/**
 * Adapter-level money validation — the mock is the demo's PayPal
 * stand-in, so it enforces the same money rules the real API and
 * every app surface enforce, at its own boundary, before any state
 * changes. Until this existed the mock trusted its inputs: the
 * payout check `Number(value) <= 0` let a non-numeric amount
 * through (NaN comparisons are false), so a payout of "abc" was
 * created as SUCCESS with a "-abc" transaction; invoice totals
 * summed to "NaN" (or went negative via a negative quantity); an
 * order of "-5.00" captured as a "-5.00" transaction; and a
 * recorded payment of "-50.00" *increased* the amount due, a zero
 * payment flipped an invoice to PARTIALLY_PAID, and an
 * overpayment was silently clamped by `Math.max` (the excess
 * vanished) — while the app-level record-payment leg states the
 * opposite rule: an overpayment is refused, never clamped.
 *
 * The rules, all checked before any mutation (a refusal leaves
 * invoices, orders, payouts, transactions, and events untouched):
 *  - Money amounts (invoice unit amounts, order amounts, payout
 *    item amounts, recorded payments) must be finite and greater
 *    than zero — as numbers, so "abc" / "" / "Infinity" refuse,
 *    not only "0.00" and negatives.
 *  - Invoice quantities must be finite and greater than zero;
 *    fractional quantities (2.5 hours) are legitimate and kept.
 *  - An invoice needs at least one item.
 *  - A recorded payment must be in the invoice's own currency
 *    and must not exceed the amount due.
 * Create-call refusals are 400 VALIDATION_ERROR (the payout
 * check's existing shape); recorded-payment refusals are 422
 * UNPROCESSABLE_ENTITY (that method's existing shape).
 */
function requirePositiveAmount(value: string, label: string, status: number, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new PayPalError(`${label} must be a positive amount — got '${value}'`, status, name);
  }
  return n;
}

function validateInvoiceItems(items: CreateInvoiceInput["items"]): void {
  if (!Array.isArray(items) || items.length === 0) {
    throw new PayPalError("An invoice needs at least one item", 400, "VALIDATION_ERROR");
  }
  for (const item of items) {
    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new PayPalError(
        `Invoice item quantities must be positive — got '${item.quantity}' for '${item.name}'`,
        400,
        "VALIDATION_ERROR",
      );
    }
    requirePositiveAmount(item.unit_amount.value, `Invoice item unit amounts ('${item.name}')`, 400, "VALIDATION_ERROR");
  }
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${String(seq).padStart(6, "0")}`;
}

export const MOCK_PAYPAL_SNAPSHOT_VERSION = 1;

/** Env var that turns on file persistence for the mock adapter. */
export const MOCK_PAYPAL_STORE_FILE_ENV = "PAYPAL_MOCK_STORE_FILE";

export class MockPayPalPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MockPayPalPersistenceError";
  }
}

export interface MockSeedOptions {
  /** Include the clearly-labeled sample dispute row (Judge Mode). Default true. */
  sampleDispute?: boolean;
  /**
   * Path of the JSON snapshot file. When set, the client loads any
   * existing snapshot from it (the seed options then do not apply)
   * and writes every mutation through. When unset, purely in-memory.
   */
  filePath?: string;
}

interface MockSnapshot {
  version: number;
  seq: number;
  invoices: Invoice[];
  orders: Order[];
  payouts: PayoutBatch[];
  transactions: Transaction[];
  disputes: Dispute[];
  emittedEvents: WebhookEvent[];
  sentReminders: SentInvoiceReminder[];
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
  /** Reminders actually sent through this adapter, in order. */
  readonly sentReminders: SentInvoiceReminder[] = [];
  private readonly filePath?: string;
  /** Whether this client's fresh state carries the flagged sample dispute. */
  private readonly sampleDispute: boolean;

  constructor(seed: MockSeedOptions = {}) {
    this.filePath = seed.filePath;
    this.sampleDispute = seed.sampleDispute !== false;
    const snap = this.filePath ? this.load() : null;
    if (snap) {
      // Restored from a snapshot: seed data (incl. the sample dispute,
      // already inside the snapshot) must not be applied a second time.
      for (const invoice of snap.invoices) this.invoices.set(invoice.id, invoice);
      for (const order of snap.orders) this.orders.set(order.id, order);
      for (const batch of snap.payouts) this.payouts.set(batch.batch_header.payout_batch_id, batch);
      this.transactions = snap.transactions;
      this.disputes = snap.disputes;
      this.emittedEvents.push(...snap.emittedEvents);
      this.sentReminders.push(...snap.sentReminders);
      // Ids must never repeat after a restart: continue the sequence
      // past both the snapshot's counter and this process's counter.
      seq = Math.max(seq, snap.seq);
      return;
    }
    this.disputes = this.initialDisputes();
  }

  /** The dispute set of a fresh client: the flagged sample row, or none. */
  private initialDisputes(): Dispute[] {
    if (!this.sampleDispute) return [];
    return [
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

  /**
   * Clear every mock resource (invoices, orders, payout batches,
   * transactions, emitted events, sent reminders) and restore the
   * dispute set to this client's fresh state — the flagged sample row
   * comes back, exactly as on a fresh client, so the Disputes surface
   * is demonstrable again. The id sequence deliberately does NOT
   * rewind: resource ids are never reused, even across a reset.
   * Persists the emptied snapshot when persistence is on. This is the
   * adapter half of the Judge Mode demo reset (see judge-mode.ts).
   * Returns what was cleared.
   */
  reset(): {
    invoices: number;
    orders: number;
    payouts: number;
    transactions: number;
    emittedEvents: number;
    sentReminders: number;
  } {
    const cleared = {
      invoices: this.invoices.size,
      orders: this.orders.size,
      payouts: this.payouts.size,
      transactions: this.transactions.length,
      emittedEvents: this.emittedEvents.length,
      sentReminders: this.sentReminders.length,
    };
    this.invoices.clear();
    this.orders.clear();
    this.payouts.clear();
    this.transactions = [];
    this.emittedEvents.length = 0;
    this.sentReminders.length = 0;
    this.disputes = this.initialDisputes();
    this.persist();
    return cleared;
  }

  /** The snapshot file this client persists to, when persistence is on. */
  get persistenceFile(): string | undefined {
    return this.filePath;
  }

  private load(): MockSnapshot | null {
    const path = this.filePath!;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      // A missing file is the normal first run — anything else must not
      // be mistaken for "no mock history yet".
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new MockPayPalPersistenceError(
        `Cannot read mock PayPal store file ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new MockPayPalPersistenceError(
        `Mock PayPal store file ${path} is not valid JSON — refusing to reseed over corrupt mock history. Fix or remove the file to start fresh.`,
      );
    }
    const snap = parsed as Partial<MockSnapshot> | null;
    if (
      !snap ||
      typeof snap !== "object" ||
      snap.version !== MOCK_PAYPAL_SNAPSHOT_VERSION ||
      typeof snap.seq !== "number" ||
      !Array.isArray(snap.invoices) ||
      !Array.isArray(snap.orders) ||
      !Array.isArray(snap.payouts) ||
      !Array.isArray(snap.transactions) ||
      !Array.isArray(snap.disputes) ||
      !Array.isArray(snap.emittedEvents) ||
      !Array.isArray(snap.sentReminders)
    ) {
      throw new MockPayPalPersistenceError(
        `Mock PayPal store file ${path} has an unsupported or malformed snapshot (expected version ${MOCK_PAYPAL_SNAPSHOT_VERSION}) — refusing to discard it silently.`,
      );
    }
    return snap as MockSnapshot;
  }

  private persist(): void {
    if (!this.filePath) return;
    const snapshot: MockSnapshot = {
      version: MOCK_PAYPAL_SNAPSHOT_VERSION,
      seq,
      invoices: [...this.invoices.values()].map((i) => structuredClone(i)),
      orders: [...this.orders.values()].map((o) => structuredClone(o)),
      payouts: [...this.payouts.values()].map((p) => structuredClone(p)),
      transactions: structuredClone(this.transactions),
      disputes: structuredClone(this.disputes),
      emittedEvents: structuredClone(this.emittedEvents),
      sentReminders: structuredClone(this.sentReminders),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    renameSync(tmp, this.filePath);
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
    validateInvoiceItems(input.items);
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
    this.persist();
    return structuredClone(invoice);
  }

  async sendInvoice(invoiceId: string): Promise<Invoice> {
    const invoice = this.mustGetInvoice(invoiceId);
    if (invoice.status !== "DRAFT") {
      throw new PayPalError(`Invoice ${invoiceId} cannot be sent from status ${invoice.status}`, 422, "UNPROCESSABLE_ENTITY");
    }
    invoice.status = "SENT";
    this.persist();
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
    const paid = requirePositiveAmount(amount.value, "Recorded payment amounts", 422, "UNPROCESSABLE_ENTITY");
    if (amount.currency_code !== invoice.due_amount.currency_code) {
      throw new PayPalError(
        `Recorded payment currency ${amount.currency_code} does not match invoice ${invoiceId}'s currency ${invoice.due_amount.currency_code}`,
        422,
        "UNPROCESSABLE_ENTITY",
      );
    }
    const due = Number(invoice.due_amount.value);
    if (paid > due) {
      throw new PayPalError(
        `Recorded payment ${amount.value} exceeds the amount due ${invoice.due_amount.value} on invoice ${invoiceId} — an overpayment is refused, never silently clamped`,
        422,
        "UNPROCESSABLE_ENTITY",
      );
    }
    invoice.due_amount = { ...invoice.due_amount, value: (due - paid).toFixed(2) };
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
    this.persist();
    return structuredClone(invoice);
  }

  async sendInvoiceReminder(invoiceId: string, input: SendInvoiceReminderInput = {}): Promise<Invoice> {
    const invoice = this.mustGetInvoice(invoiceId);
    // A reminder only makes sense for an invoice that is out and still
    // owes money — the real API rejects the rest, and so does the mock.
    const remindable = invoice.status === "SENT" || invoice.status === "PARTIALLY_PAID" || invoice.status === "SCHEDULED";
    if (!remindable) {
      throw new PayPalError(
        `Invoice ${invoiceId} cannot be reminded from status ${invoice.status} — only an open invoice with an amount due can be reminded`,
        422,
        "UNPROCESSABLE_ENTITY",
      );
    }
    const recipient = invoice.primary_recipients[0]?.billing_info;
    this.sentReminders.push({
      invoiceId: invoice.id,
      recipient: recipient
        ? { name: recipient.name, email_address: recipient.email_address }
        : { name: "", email_address: "" },
      subject: input.subject,
      note: input.note,
      sentAt: new Date().toISOString(),
    });
    this.persist();
    return structuredClone(invoice);
  }

  private mustGetInvoice(id: string): Invoice {
    const invoice = this.invoices.get(id);
    if (!invoice) throw new PayPalError(`Invoice ${id} not found`, 404);
    return invoice;
  }

  /* ---------------- Orders v2 ---------------- */

  async createOrder(input: CreateOrderInput): Promise<Order> {
    requirePositiveAmount(input.amount.value, "Order amounts", 400, "VALIDATION_ERROR");
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
    this.persist();
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
    this.persist();
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
      requirePositiveAmount(item.amount.value, "Payout item amounts", 400, "VALIDATION_ERROR");
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
    this.persist();
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
