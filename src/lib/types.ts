/**
 * LedgerPilot domain types.
 *
 * Shapes intentionally mirror the PayPal REST resources they wrap
 * (Invoicing v2, Orders v2, Payouts, Disputes, Transaction Search)
 * so the mock adapter and the future sandbox adapter are interchangeable.
 */

export type CurrencyCode = "USD" | "EUR" | "GBP";

export interface Money {
  currency_code: CurrencyCode;
  value: string; // PayPal represents amounts as decimal strings.
}

export interface Party {
  name: string;
  email_address: string;
}

/* ------------------------------------------------------------------ */
/* Invoicing v2                                                        */
/* ------------------------------------------------------------------ */

export type InvoiceStatus =
  | "DRAFT"
  | "SENT"
  | "SCHEDULED"
  | "PAID"
  | "MARKED_AS_PAID"
  | "CANCELLED"
  | "REFUNDED"
  | "PARTIALLY_PAID";

export interface InvoiceItemInput {
  name: string;
  quantity: string;
  unit_amount: Money;
}

export interface CreateInvoiceInput {
  recipient: Party;
  items: InvoiceItemInput[];
  note?: string;
  /** ISO date (yyyy-mm-dd) the invoice is due. */
  dueDate?: string;
  reference?: string;
}

export interface Invoice {
  id: string;
  status: InvoiceStatus;
  detail: {
    invoice_number: string;
    note?: string;
    payment_term?: { due_date?: string };
    reference?: string;
  };
  invoicer: Party;
  primary_recipients: Array<{ billing_info: { name: string; email_address: string } }>;
  items: InvoiceItemInput[];
  amount: Money;
  due_amount: Money;
  links: Array<{ href: string; rel: string; method: string }>;
}

/* ------------------------------------------------------------------ */
/* Orders v2                                                           */
/* ------------------------------------------------------------------ */

export type OrderStatus = "CREATED" | "SAVED" | "APPROVED" | "COMPLETED" | "VOIDED";

export interface CreateOrderInput {
  description: string;
  amount: Money;
  reference_id?: string;
}

export interface Order {
  id: string;
  status: OrderStatus;
  intent: "CAPTURE";
  purchase_units: Array<{
    reference_id?: string;
    description: string;
    amount: Money;
    payments?: {
      captures: Array<{ id: string; status: string; amount: Money }>;
    };
  }>;
  links: Array<{ href: string; rel: string; method: string }>;
}

/* ------------------------------------------------------------------ */
/* Payouts                                                             */
/* ------------------------------------------------------------------ */

export type PayoutBatchStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "DENIED" | "CANCELED";
export type PayoutItemStatus = "SUCCESS" | "FAILED" | "PENDING" | "UNCLAIMED" | "RETURNED" | "BLOCKED";

export interface PayoutItemInput {
  recipient: Party;
  amount: Money;
  note?: string;
  sender_item_id?: string;
}

export interface CreatePayoutInput {
  items: PayoutItemInput[];
  emailSubject?: string;
  emailMessage?: string;
}

export interface PayoutBatch {
  batch_header: {
    payout_batch_id: string;
    batch_status: PayoutBatchStatus;
    time_created: string;
    sender_batch_header: { sender_batch_id: string; email_subject?: string; email_message?: string };
  };
  items: Array<{
    payout_item_id: string;
    transaction_status: PayoutItemStatus;
    payout_item: PayoutItemInput & { receiver: string };
  }>;
  links: Array<{ href: string; rel: string; method: string }>;
}

/* ------------------------------------------------------------------ */
/* Disputes + Transaction Search (read-only)                           */
/* ------------------------------------------------------------------ */

export interface Dispute {
  dispute_id: string;
  create_time: string;
  update_time: string;
  disputed_transactions: Array<{ seller_transaction_id: string; buyer: Party }>;
  amount: Money;
  reason: string;
  status: "OPEN" | "WAITING_FOR_BUYER_RESPONSE" | "WAITING_FOR_SELLER_RESPONSE" | "RESOLVED";
  dispute_life_cycle_stage: string;
  /** True when this row is seeded demo data, not a live PayPal record. */
  sample?: boolean;
}

export interface Transaction {
  transaction_id: string;
  transaction_event_code: string;
  transaction_initiation_date: string;
  transaction_amount: Money;
  transaction_status: "S" | "P" | "F" | "D";
  transaction_subject?: string;
  payer_info?: { account_reference?: string; email_address?: string; name?: string };
}

/* ------------------------------------------------------------------ */
/* Webhooks                                                            */
/* ------------------------------------------------------------------ */

export type WebhookEventType =
  | "INVOICING.INVOICE.PAID"
  | "INVOICING.INVOICE.CANCELLED"
  | "PAYMENT.CAPTURE.COMPLETED"
  | "PAYMENT.PAYOUTS-ITEM.SUCCEEDED"
  | "PAYMENT.PAYOUTS-ITEM.FAILED"
  | "CUSTOMER.DISPUTE.CREATED";

export interface WebhookEvent {
  id: string;
  create_time: string;
  resource_type: string;
  event_type: WebhookEventType | string;
  summary: string;
  resource: Record<string, unknown>;
  event_version: string;
  resource_version: string;
}

/* ------------------------------------------------------------------ */
/* Agent layer                                                         */
/* ------------------------------------------------------------------ */

export type ActionType = "create_invoice" | "create_order" | "draft_payout" | "send_reminder";

export interface ActionStep {
  type: ActionType;
  /** Human-readable summary rendered in the plan-review checklist. */
  description: string;
  /** The exact PayPal call this step will make, shown before approval. */
  paypalCall: { method: string; path: string };
  payload: Record<string, unknown>;
  /** When set, this step only runs after the named trigger fires (e.g. an invoice is paid). */
  trigger?: { on: WebhookEventType; resourceId?: string };
}

export interface ActionPlan {
  id: string;
  brief: string;
  steps: ActionStep[];
  status: "pending_approval" | "approved" | "rejected" | "executing" | "completed" | "failed";
  createdAt: string;
}

export interface ActivityRecord {
  id: string;
  planId?: string;
  kind: "plan" | "paypal_call" | "webhook" | "approval" | "system";
  summary: string;
  detail?: Record<string, unknown>;
  createdAt: string;
}
