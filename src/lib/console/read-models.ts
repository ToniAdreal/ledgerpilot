/**
 * Console read models — the shapes the AG Grid surfaces consume.
 *
 * These are pure projections over adapter resources + the ledger store:
 * no PayPal calls happen here, so the same rows feed the API routes,
 * the grids, and the tests. Money totals are always grouped by currency
 * (never summed across currencies).
 */

import { resolveCheckoutView, type CheckoutViewKind } from "../checkout/checkout-link";
import type {
  ActionPlan,
  ActivityRecord,
  Dispute,
  Invoice,
  InvoiceStatus,
  Order,
  PayoutBatch,
  Transaction,
} from "../types";

/* ------------------------------------------------------------------ */
/* Invoices grid                                                       */
/* ------------------------------------------------------------------ */

export interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  recipientName: string;
  recipientEmail: string;
  status: InvoiceStatus;
  currency: string;
  /** Formatted decimal string, PayPal-style (e.g. "450.00"). */
  amount: string;
  amountValue: number;
  dueAmount: string;
  dueValue: number;
  /** Portion already collected: amount - due (full amount once PAID). */
  collectedValue: number;
  dueDate?: string;
  /** Open invoice whose due date is before the reference date. */
  overdue: boolean;
}

const OPEN_INVOICE_STATUSES: ReadonlySet<InvoiceStatus> = new Set([
  "SENT",
  "SCHEDULED",
  "PARTIALLY_PAID",
]);

export function toInvoiceRow(invoice: Invoice, referenceDate: string): InvoiceRow {
  const recipient = invoice.primary_recipients[0]?.billing_info;
  const amountValue = Number(invoice.amount.value);
  const dueValue = Number(invoice.due_amount.value);
  const dueDate = invoice.detail.payment_term?.due_date;
  return {
    id: invoice.id,
    invoiceNumber: invoice.detail.invoice_number,
    recipientName: recipient?.name ?? "",
    recipientEmail: recipient?.email_address ?? "",
    status: invoice.status,
    currency: invoice.amount.currency_code,
    amount: invoice.amount.value,
    amountValue,
    dueAmount: invoice.due_amount.value,
    dueValue,
    collectedValue: Math.max(0, amountValue - dueValue),
    dueDate,
    overdue:
      OPEN_INVOICE_STATUSES.has(invoice.status) && !!dueDate && dueDate < referenceDate,
  };
}

/** Newest first (adapter lists are in creation order). */
export function buildInvoiceRows(invoices: Invoice[], referenceDate: string): InvoiceRow[] {
  return [...invoices].reverse().map((i) => toInvoiceRow(i, referenceDate));
}

/* ------------------------------------------------------------------ */
/* Orders grid                                                         */
/* ------------------------------------------------------------------ */

export interface OrderRow {
  id: string;
  status: Order["status"];
  description: string;
  referenceId: string;
  currency: string;
  amount: string;
  amountValue: number;
  captureId: string;
  captureStatus: string;
  /** True once a capture exists (order reached COMPLETED via capture). */
  captured: boolean;
  /**
   * Buyer-view state for the order's checkout link (src/lib/checkout):
   * `payable` only while an approval link exists and the order is
   * neither captured nor voided.
   */
  checkoutState: CheckoutViewKind;
  /** The buyer checkout URL — present only when checkoutState is `payable`. */
  checkoutUrl: string;
  /** True when checkoutUrl is the mock adapter's stand-in, not a PayPal URL. */
  checkoutIsMock: boolean;
  /** Short label for the Buyer view column ("Open checkout", "Paid via checkout", …). */
  checkoutLabel: string;
}

export function toOrderRow(order: Order): OrderRow {
  const unit = order.purchase_units[0];
  const capture = unit?.payments?.captures?.[0];
  const view = resolveCheckoutView(order);
  return {
    id: order.id,
    status: order.status,
    description: unit?.description ?? "",
    referenceId: unit?.reference_id ?? "",
    currency: unit?.amount.currency_code ?? "USD",
    amount: unit?.amount.value ?? "0.00",
    amountValue: Number(unit?.amount.value ?? "0"),
    captureId: capture?.id ?? "",
    captureStatus: capture?.status ?? "",
    captured: !!capture,
    checkoutState: view.kind,
    checkoutUrl: view.href ?? "",
    checkoutIsMock: view.isMock,
    checkoutLabel: view.label,
  };
}

/** Newest first (adapter lists are in creation order). */
export function buildOrderRows(orders: Order[]): OrderRow[] {
  return [...orders].reverse().map(toOrderRow);
}

/* ------------------------------------------------------------------ */
/* Payouts grid — one row per payout item, batch context flattened in */
/* ------------------------------------------------------------------ */

export interface PayoutRow {
  /** Payout item id — the stable row key. */
  id: string;
  batchId: string;
  batchStatus: PayoutBatch["batch_header"]["batch_status"];
  recipientName: string;
  recipientEmail: string;
  status: string;
  currency: string;
  amount: string;
  amountValue: number;
  note: string;
  timeCreated: string;
}

export function buildPayoutRows(batches: PayoutBatch[]): PayoutRow[] {
  const rows: PayoutRow[] = [];
  for (const batch of batches) {
    for (const item of batch.items) {
      rows.push({
        id: item.payout_item_id,
        batchId: batch.batch_header.payout_batch_id,
        batchStatus: batch.batch_header.batch_status,
        recipientName: item.payout_item.recipient.name,
        recipientEmail: item.payout_item.receiver,
        status: item.transaction_status,
        currency: item.payout_item.amount.currency_code,
        amount: item.payout_item.amount.value,
        amountValue: Number(item.payout_item.amount.value),
        note: item.payout_item.note ?? "",
        timeCreated: batch.batch_header.time_created,
      });
    }
  }
  // Newest first: batches are listed in creation order, items keep batch order.
  return rows.reverse();
}

/* ------------------------------------------------------------------ */
/* Activity / webhook audit grid                                       */
/* ------------------------------------------------------------------ */

export interface ActivityRow {
  id: string;
  createdAt: string;
  kind: ActivityRecord["kind"];
  planId: string;
  summary: string;
  /** The webhook event id when this row records a webhook delivery. */
  eventId?: string;
  /** Flattened detail payload for grid inspection / CSV export. */
  detailJson: string;
}

/** Newest first — the audit trail reads top-down in the console. */
export function buildActivityRows(activity: ActivityRecord[]): ActivityRow[] {
  return [...activity].reverse().map((a) => ({
    id: a.id,
    createdAt: a.createdAt,
    kind: a.kind,
    planId: a.planId ?? "",
    summary: a.summary,
    eventId: typeof a.detail?.eventId === "string" ? a.detail.eventId : undefined,
    detailJson: a.detail ? JSON.stringify(a.detail) : "",
  }));
}

/* ------------------------------------------------------------------ */
/* Disputes grid (read-only)                                           */
/* ------------------------------------------------------------------ */

export interface DisputeRow {
  id: string;
  buyerName: string;
  buyerEmail: string;
  sellerTransactionId: string;
  status: Dispute["status"];
  stage: string;
  /** Raw PayPal reason code, e.g. MERCHANDISE_OR_SERVICE_NOT_RECEIVED. */
  reason: string;
  currency: string;
  amount: string;
  amountValue: number;
  createdAt: string;
  /** Seller-response deadline (ISO timestamp), when PayPal provides one. */
  responseDueDate?: string;
  /**
   * Open dispute whose response deadline's date is before the
   * reference date — the seller is late to respond.
   */
  responseOverdue: boolean;
  /** Seeded demo row, never a live PayPal record — always surfaced. */
  sample: boolean;
}

export function toDisputeRow(dispute: Dispute, referenceDate: string): DisputeRow {
  const txn = dispute.disputed_transactions[0];
  return {
    id: dispute.dispute_id,
    buyerName: txn?.buyer.name ?? "",
    buyerEmail: txn?.buyer.email_address ?? "",
    sellerTransactionId: txn?.seller_transaction_id ?? "",
    status: dispute.status,
    stage: dispute.dispute_life_cycle_stage,
    reason: dispute.reason,
    currency: dispute.amount.currency_code,
    amount: dispute.amount.value,
    amountValue: Number(dispute.amount.value),
    createdAt: dispute.create_time,
    responseDueDate: dispute.response_due_date,
    responseOverdue:
      dispute.status !== "RESOLVED" &&
      !!dispute.response_due_date &&
      dispute.response_due_date.slice(0, 10) < referenceDate,
    sample: dispute.sample === true,
  };
}

/** Newest first (adapter lists are in creation order). */
export function buildDisputeRows(disputes: Dispute[], referenceDate: string): DisputeRow[] {
  return [...disputes].reverse().map((d) => toDisputeRow(d, referenceDate));
}

/* ------------------------------------------------------------------ */
/* Reconciliation grid — Transaction Search (read-only)                */
/* ------------------------------------------------------------------ */

export interface TransactionRow {
  id: string;
  eventCode: string;
  date: string;
  currency: string;
  /** Signed, formatted decimal string as PayPal reports it. */
  amount: string;
  amountValue: number;
  /** Raw Transaction Search status code: S / P / F / D. */
  status: Transaction["transaction_status"];
  subject: string;
  payerName: string;
  payerEmail: string;
}

/** Newest first (the adapter ledger is in initiation order). */
export function buildTransactionRows(transactions: Transaction[]): TransactionRow[] {
  return [...transactions].reverse().map((t) => ({
    id: t.transaction_id,
    eventCode: t.transaction_event_code,
    date: t.transaction_initiation_date,
    currency: t.transaction_amount.currency_code,
    amount: t.transaction_amount.value,
    amountValue: Number(t.transaction_amount.value),
    status: t.transaction_status,
    subject: t.transaction_subject ?? "",
    payerName: t.payer_info?.name ?? "",
    payerEmail: t.payer_info?.email_address ?? "",
  }));
}

/* ------------------------------------------------------------------ */
/* KPI strip                                                           */
/* ------------------------------------------------------------------ */

export interface MoneyTotal {
  currency_code: string;
  value: string;
}

export interface ConsoleSummary {
  /** Open money still owed, per currency. */
  outstanding: MoneyTotal[];
  /**
   * Money collected against invoices, per currency. All-time: the
   * adapter's invoice shape carries no creation timestamp, so a
   * "this month" cut is not computable until the sandbox adapter
   * adds one — the console labels this honestly as collected-to-date.
   */
  collected: MoneyTotal[];
  /** Captured Orders v2 totals (COMPLETED orders only), per currency. */
  capturedOrders: MoneyTotal[];
  /** Sent payout totals (SUCCESS items only), per currency. */
  payoutsSent: MoneyTotal[];
  pendingApprovals: number;
  awaitingTrigger: number;
  openDisputes: number;
  counts: {
    invoices: number;
    orders: number;
    payouts: number;
    plans: number;
    activity: number;
    disputes: number;
    transactions: number;
  };
}

function totalsByCurrency(rows: Array<{ currency: string; value: number }>): MoneyTotal[] {
  const byCurrency = new Map<string, number>();
  for (const row of rows) {
    byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + row.value);
  }
  return [...byCurrency.entries()]
    .filter(([, v]) => v !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency_code, v]) => ({ currency_code, value: v.toFixed(2) }));
}

export function computeSummary(input: {
  invoices: Invoice[];
  orders: Order[];
  payouts: PayoutBatch[];
  disputes: Dispute[];
  transactions?: Transaction[];
  plans: ActionPlan[];
  activity: ActivityRecord[];
  referenceDate: string;
}): ConsoleSummary {
  const rows = buildInvoiceRows(input.invoices, input.referenceDate);
  const orderRows = buildOrderRows(input.orders);
  const payoutRows = buildPayoutRows(input.payouts);
  return {
    outstanding: totalsByCurrency(
      rows
        .filter((r) => OPEN_INVOICE_STATUSES.has(r.status))
        .map((r) => ({ currency: r.currency, value: r.dueValue })),
    ),
    collected: totalsByCurrency(rows.map((r) => ({ currency: r.currency, value: r.collectedValue }))),
    capturedOrders: totalsByCurrency(
      orderRows
        .filter((r) => r.status === "COMPLETED")
        .map((r) => ({ currency: r.currency, value: r.amountValue })),
    ),
    payoutsSent: totalsByCurrency(
      payoutRows
        .filter((r) => r.status === "SUCCESS")
        .map((r) => ({ currency: r.currency, value: r.amountValue })),
    ),
    pendingApprovals: input.plans.filter((p) => p.status === "pending_approval").length,
    awaitingTrigger: input.plans.filter((p) => p.status === "awaiting_trigger").length,
    openDisputes: input.disputes.filter((d) => d.status !== "RESOLVED").length,
    counts: {
      invoices: input.invoices.length,
      orders: input.orders.length,
      payouts: input.payouts.length,
      plans: input.plans.length,
      activity: input.activity.length,
      disputes: input.disputes.length,
      transactions: input.transactions?.length ?? 0,
    },
  };
}
