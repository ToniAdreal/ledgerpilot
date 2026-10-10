import type {
  CreateInvoiceInput,
  CreateOrderInput,
  CreatePayoutInput,
  Dispute,
  Invoice,
  Order,
  PayoutBatch,
  SendInvoiceReminderInput,
  Transaction,
  WebhookEvent,
} from "../types";

/**
 * The PayPal adapter contract. Every LedgerPilot feature talks to PayPal
 * only through this interface, so `mock` and `sandbox` implementations are
 * interchangeable (PAYPAL_MODE env var, see ./index.ts).
 *
 * Method paths in comments are the real REST endpoints the sandbox
 * adapter will call; the mock adapter reproduces their resource shapes.
 */
export interface PayPalClient {
  readonly mode: "mock" | "sandbox";

  /* Invoicing v2 — POST /v2/invoicing/invoices */
  createInvoice(input: CreateInvoiceInput): Promise<Invoice>;
  /* Invoicing v2 — POST /v2/invoicing/invoices/:id/send */
  sendInvoice(invoiceId: string): Promise<Invoice>;
  /* Invoicing v2 — GET /v2/invoicing/invoices/:id */
  getInvoice(invoiceId: string): Promise<Invoice>;
  /* Invoicing v2 — GET /v2/invoicing/invoices */
  listInvoices(): Promise<Invoice[]>;
  /* Invoicing v2 — POST /v2/invoicing/invoices/:id/payments (record a payment made outside PayPal) */
  recordInvoicePayment(invoiceId: string, amount: { value: string; currency_code: string }): Promise<Invoice>;
  /* Invoicing v2 — POST /v2/invoicing/invoices/:id/remind (send a payment reminder for an open invoice) */
  sendInvoiceReminder(invoiceId: string, input?: SendInvoiceReminderInput): Promise<Invoice>;

  /* Orders v2 — POST /v2/checkout/orders */
  createOrder(input: CreateOrderInput): Promise<Order>;
  /* Orders v2 — POST /v2/checkout/orders/:id/capture */
  captureOrder(orderId: string): Promise<Order>;
  /* Orders v2 — GET /v2/checkout/orders */
  listOrders(): Promise<Order[]>;

  /* Payouts — POST /v1/payments/payouts */
  createPayout(input: CreatePayoutInput): Promise<PayoutBatch>;
  /* Payouts — GET /v1/payments/payouts */
  listPayouts(): Promise<PayoutBatch[]>;

  /* Disputes — GET /v1/customer/disputes (read-only) */
  listDisputes(): Promise<Dispute[]>;
  /* Transaction Search — GET /v1/reporting/transactions (read-only) */
  listTransactions(): Promise<Transaction[]>;

  /**
   * Webhooks — POST /v1/notifications/verify-webhook-signature.
   * The mock adapter verifies against the deterministic mock signature
   * scheme documented in mock.ts; the sandbox adapter calls PayPal.
   */
  verifyWebhookSignature(headers: Record<string, string>, event: WebhookEvent): Promise<boolean>;
}

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly name_: string = "RESOURCE_NOT_FOUND",
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

export class PayPalNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(
      `PayPal sandbox mode requires: ${missing.join(", ")}. ` +
        `Set them (see .env.example) or use PAYPAL_MODE=mock.`,
    );
    this.name = "PayPalNotConfiguredError";
  }
}
