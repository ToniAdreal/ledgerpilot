/**
 * Invoice record-payment leg — recording a payment made outside
 * PayPal for an open invoice (CONCEPT.md §3.2 step 3: the invoice leg
 * is paid either on PayPal's hosted page, yielding the signed
 * INVOICING.INVOICE.PAID webhook, or via the Invoicing record-payment
 * API — POST /v2/invoicing/invoices/:id/payments).
 *
 * Until this module existed, that second path was reachable only for
 * the Judge Mode spine invoice (`simulateJudgeInvoicePayment`):
 * every other open invoice in the console — the seeded history, an
 * invoice a seller drafted through a form — could be reminded but
 * never marked paid from inside the app, so a gated payout bound to
 * it could only fire if a test called the adapter directly. This
 * module is the general leg, shaped exactly like the checkout
 * capture leg (`captureCheckoutOrder`):
 *
 *  - It is NOT an agent action and NOT a plan step. Recording a
 *    payment is the seller noting money that already arrived outside
 *    PayPal (the documented local-run / external-payment path); the
 *    approval gate governs the agent committing or spending the
 *    seller's account, and receiving money was never gated — the
 *    same reasoning as capture and the Judge Mode payment leg.
 *  - The amount defaults to the full outstanding due amount; an
 *    explicit amount records a partial payment (the invoice flips
 *    to PARTIALLY_PAID and no PAID event fires until the balance
 *    reaches zero). Amounts are validated before any adapter call:
 *    positive, finite, in the invoice's own currency, and never
 *    more than the amount due — an overpayment is refused, never
 *    silently clamped.
 *  - The call goes through the adapter, is written to the audit log
 *    as the exact PayPal call, and the resulting
 *    INVOICING.INVOICE.PAID event (full payments only, since that is
 *    the only event the adapter emits) is processed by the sync
 *    reconciler — the same code path a webhook delivery takes, so a
 *    trigger-gated payout bound to this invoice fires here too.
 *  - Recording is idempotent at this layer: an already-PAID (or
 *    MARKED_AS_PAID) invoice returns `alreadyPaid: true` and makes
 *    no second call; an unknown id is a 404 and a DRAFT / CANCELLED /
 *    REFUNDED invoice an honest 409, never a silent no-op dressed
 *    as success.
 */

import { syncFromPayPal, type SyncResult } from "../agent/reconciler";
import type { LedgerStore } from "../agent/store";
import type { PayPalClient } from "../paypal/client";
import type { Invoice } from "../types";

export class InvoicePaymentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "InvoicePaymentError";
  }
}

export interface RecordedInvoicePaymentSummary {
  id: string;
  status: Invoice["status"];
  /** The amount this call recorded, formatted to 2dp. */
  recordedAmount: string;
  /** Outstanding amount after this call, formatted to 2dp. */
  dueAmount: string;
  currency_code: string;
}

export interface RecordInvoicePaymentResult {
  alreadyPaid: boolean;
  invoice: RecordedInvoicePaymentSummary;
  /** Reconciler result; null when the invoice was already paid. */
  sync: SyncResult | null;
}

const PAYABLE_STATUSES: ReadonlySet<Invoice["status"]> = new Set([
  "SENT",
  "PARTIALLY_PAID",
  "SCHEDULED",
]);

export interface RecordInvoicePaymentInput {
  /** Explicit amount to record; omitted = the full amount due. */
  amount?: string;
  /** Currency for an explicit amount; must match the invoice's. */
  currency_code?: string;
}

export async function recordInvoicePayment(
  client: PayPalClient,
  store: LedgerStore,
  invoiceId: string,
  input: RecordInvoicePaymentInput = {},
): Promise<RecordInvoicePaymentResult> {
  const invoice = (await client.listInvoices()).find((i) => i.id === invoiceId);
  if (!invoice) {
    throw new InvoicePaymentError(`Invoice ${invoiceId} not found — no payment was recorded.`, 404);
  }
  if (invoice.status === "PAID" || invoice.status === "MARKED_AS_PAID") {
    return {
      alreadyPaid: true,
      invoice: {
        id: invoice.id,
        status: invoice.status,
        recordedAmount: "0.00",
        dueAmount: invoice.due_amount.value,
        currency_code: invoice.due_amount.currency_code,
      },
      sync: null,
    };
  }
  if (!PAYABLE_STATUSES.has(invoice.status)) {
    throw new InvoicePaymentError(
      `Invoice ${invoiceId} is ${invoice.status} — only an open invoice (SENT, PARTIALLY_PAID, or SCHEDULED) can be recorded as paid.`,
      409,
    );
  }

  const due = Number(invoice.due_amount.value);
  let amount = due;
  if (input.amount !== undefined) {
    amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new InvoicePaymentError(
        `'amount' must be a positive amount — got '${input.amount}'. No payment was recorded.`,
        422,
      );
    }
    if (amount > due) {
      throw new InvoicePaymentError(
        `'amount' ${amount.toFixed(2)} exceeds the amount due ${invoice.due_amount.value} on invoice ${invoiceId}. No payment was recorded.`,
        422,
      );
    }
  }
  const currency = input.currency_code ?? invoice.due_amount.currency_code;
  if (currency !== invoice.due_amount.currency_code) {
    throw new InvoicePaymentError(
      `Currency ${currency} does not match invoice ${invoiceId}'s currency ${invoice.due_amount.currency_code}. No payment was recorded.`,
      422,
    );
  }
  const recordedAmount = amount.toFixed(2);
  // The positivity check above governs the input number; this one
  // governs the amount actually recorded. A sub-cent payment
  // (0.001–0.004) is positive as a number but records as "0.00" — a
  // zero-value payment that moves nothing yet would read as success.
  if (Number(recordedAmount) <= 0) {
    throw new InvoicePaymentError(
      `'amount' ${input.amount} rounds to 0.00 when kept to two decimal places — name an amount of at least 0.01. No payment was recorded.`,
      422,
    );
  }

  let paid: Invoice;
  try {
    paid = await client.recordInvoicePayment(invoiceId, {
      value: recordedAmount,
      currency_code: currency,
    });
  } catch (err) {
    // A refused record-payment is part of the audit trail, not a
    // silent failure (same discipline as the capture leg).
    const message = err instanceof Error ? err.message : String(err);
    store.record({
      kind: "system",
      summary: `Invoice payment recording for invoice ${invoiceId} failed: ${message}`,
      detail: { invoiceId, recorded: false },
    });
    throw err;
  }

  store.record({
    kind: "paypal_call",
    summary:
      `POST /v2/invoicing/invoices/${paid.id}/payments → payment recorded ` +
      `(${currency} ${recordedAmount}) — invoice ${paid.detail.invoice_number} now ${paid.status}` +
      (paid.status === "PARTIALLY_PAID" ? `, ${paid.due_amount.value} still due` : ""),
    detail: { invoiceId: paid.id, recordedAmount, status: paid.status, recorded: true },
  });

  // Process the INVOICING.INVOICE.PAID event (emitted on a full
  // payment) through the reconciler — exactly once, the same code
  // path a webhook delivery takes. A partial payment emits no event,
  // so this is a no-op for it.
  const sync = await syncFromPayPal(store, client);
  return {
    alreadyPaid: false,
    invoice: {
      id: paid.id,
      status: paid.status,
      recordedAmount,
      dueAmount: paid.due_amount.value,
      currency_code: paid.due_amount.currency_code,
    },
    sync,
  };
}
