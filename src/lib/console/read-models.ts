/**
 * Console read models — the shapes the AG Grid surfaces consume.
 *
 * These are pure projections over adapter resources + the ledger store:
 * no PayPal calls happen here, so the same rows feed the API routes,
 * the grids, and the tests. Money totals are always grouped by currency
 * (never summed across currencies).
 */

import type {
  ActionPlan,
  ActivityRecord,
  Dispute,
  Invoice,
  InvoiceStatus,
  Order,
  PayoutBatch,
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
  pendingApprovals: number;
  awaitingTrigger: number;
  openDisputes: number;
  counts: { invoices: number; orders: number; payouts: number; plans: number; activity: number };
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
  plans: ActionPlan[];
  activity: ActivityRecord[];
  referenceDate: string;
}): ConsoleSummary {
  const rows = buildInvoiceRows(input.invoices, input.referenceDate);
  return {
    outstanding: totalsByCurrency(
      rows
        .filter((r) => OPEN_INVOICE_STATUSES.has(r.status))
        .map((r) => ({ currency: r.currency, value: r.dueValue })),
    ),
    collected: totalsByCurrency(rows.map((r) => ({ currency: r.currency, value: r.collectedValue }))),
    pendingApprovals: input.plans.filter((p) => p.status === "pending_approval").length,
    awaitingTrigger: input.plans.filter((p) => p.status === "awaiting_trigger").length,
    openDisputes: input.disputes.filter((d) => d.status !== "RESOLVED").length,
    counts: {
      invoices: input.invoices.length,
      orders: input.orders.length,
      payouts: input.payouts.length,
      plans: input.plans.length,
      activity: input.activity.length,
    },
  };
}
