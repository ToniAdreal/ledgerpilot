/**
 * Dispute-evidence summaries — the second half of CONCEPT.md §1's AI
 * component (3): "AI-drafted payment reminders and dispute-evidence
 * summaries from transaction data." Payment reminders were wired to
 * the real Invoicing `/remind` call in an earlier run; dispute
 * summaries were never built — the Disputes surface stopped at a
 * read-only grid. This module builds them, deterministically.
 *
 * Trust rules, enforced here (not just documented):
 *
 *  - **Draft only, never submitted.** LedgerPilot's Disputes
 *    integration is read-only (CONCEPT.md §3.1). The summary is a
 *    seller-review draft: it assembles what the seller's own records
 *    actually show and names what is missing. Nothing in this module
 *    calls a mutating PayPal endpoint — it takes plain data in and
 *    returns plain data out.
 *  - **No invented evidence.** A fact appears in the draft only when
 *    it is present in the dispute record, a matched Transaction
 *    Search row, or a matched invoice. In particular LedgerPilot
 *    holds no shipping / fulfilment data, so "delivery proof" is
 *    always reported as a gap to fill by hand — never asserted.
 *  - **Matching is explicit and conservative.** A transaction matches
 *    only on an exact `transaction_id` = the dispute's
 *    `seller_transaction_id`. An invoice matches only via the matched
 *    transaction's subject ("Payment for invoice <number>") or by
 *    buyer email + currency + amount together. Anything weaker is
 *    reported as "no match", not guessed.
 *  - **Sample honesty.** A seeded sample dispute (`sample: true`)
 *    keeps its flag in the summary headline and draft, so a judge
 *    never reads seeded data as a live PayPal record.
 */

import type { PayPalClient } from "../paypal/client";
import type { Dispute, Invoice, Transaction } from "../types";

export class DisputeEvidenceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DisputeEvidenceError";
  }
}

/* ------------------------------------------------------------------ */
/* Reason labels                                                       */
/* ------------------------------------------------------------------ */

const REASON_LABELS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Merchandise or service not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Merchandise or service not as described",
  UNAUTHORISED: "Unauthorised transaction",
  UNAUTHORIZED: "Unauthorised transaction",
  BILLING_DISPUTE: "Billing dispute",
  CREDIT_NOT_PROCESSED: "Credit not processed",
  DUPLICATE_TRANSACTION: "Duplicate transaction",
  INCORRECT_AMOUNT: "Incorrect amount",
  PAYMENT_BY_OTHER_MEANS: "Payment made by other means",
  CANCELLED_RECURRING_BILLING: "Cancelled recurring billing",
  OTHER: "Other",
};

/** Human-readable label for a PayPal dispute reason code. */
export function humanizeDisputeReason(reason: string): string {
  const known = REASON_LABELS[reason];
  if (known) return known;
  const words = reason.trim().toLowerCase().replace(/_/g, " ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unspecified reason";
}

/* ------------------------------------------------------------------ */
/* Summary shape                                                       */
/* ------------------------------------------------------------------ */

export type DisputeUrgency = "resolved" | "overdue" | "due_soon" | "open";

export interface EvidenceChecklistItem {
  label: string;
  present: boolean;
  detail: string;
}

export interface MatchedTransactionSummary {
  transactionId: string;
  eventCode: string;
  date: string;
  amount: string;
  currency_code: string;
  status: string;
  subject: string;
}

export interface MatchedInvoiceSummary {
  invoiceId: string;
  invoiceNumber: string;
  status: Invoice["status"];
  amount: string;
  currency_code: string;
  matchedVia: "transaction_subject" | "buyer_and_amount";
}

export interface DisputeEvidenceSummary {
  disputeId: string;
  /** Seeded demo row — never a live PayPal record. */
  sample: boolean;
  status: Dispute["status"];
  stage: string;
  reasonCode: string;
  reasonLabel: string;
  buyerName: string;
  buyerEmail: string;
  sellerTransactionId: string;
  amount: string;
  currency_code: string;
  createdAt: string;
  responseDueDate?: string;
  /** Whole days from the reference date to the deadline date; negative = past due. Null when no deadline is known. */
  daysRemaining: number | null;
  isOpen: boolean;
  urgency: DisputeUrgency;
  headline: string;
  /** Verified facts only — each line is traceable to an input record. */
  facts: string[];
  checklist: EvidenceChecklistItem[];
  /** What the seller must still supply by hand before responding. */
  gaps: string[];
  matchedTransaction: MatchedTransactionSummary | null;
  matchedInvoice: MatchedInvoiceSummary | null;
  /** The seller-review draft response text. Never submitted anywhere. */
  draftResponse: string;
  disclaimer: string;
}

export const EVIDENCE_DISCLAIMER =
  "Draft for seller review only — not submitted to PayPal. LedgerPilot's Disputes integration is read-only; " +
  "the seller reviews, completes the gaps, and responds in PayPal. No fact in this draft comes from anywhere " +
  "other than the dispute record, Transaction Search, and the seller's invoices.";

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

function matchTransaction(
  dispute: Dispute,
  transactions: Transaction[],
): MatchedTransactionSummary | null {
  const sellerTransactionId = dispute.disputed_transactions[0]?.seller_transaction_id;
  if (!sellerTransactionId) return null;
  const txn = transactions.find((t) => t.transaction_id === sellerTransactionId);
  if (!txn) return null;
  return {
    transactionId: txn.transaction_id,
    eventCode: txn.transaction_event_code,
    date: txn.transaction_initiation_date,
    amount: txn.transaction_amount.value,
    currency_code: txn.transaction_amount.currency_code,
    status: txn.transaction_status,
    subject: txn.transaction_subject ?? "",
  };
}

function matchInvoice(
  dispute: Dispute,
  invoices: Invoice[],
  matchedTransaction: MatchedTransactionSummary | null,
): MatchedInvoiceSummary | null {
  // Strongest link: the matched transaction's subject names the invoice.
  if (matchedTransaction?.subject) {
    const m = /invoice\s+(\S+)/i.exec(matchedTransaction.subject);
    const invoiceNumber = m?.[1];
    if (invoiceNumber) {
      const byNumber = invoices.find((i) => i.detail.invoice_number === invoiceNumber);
      if (byNumber) {
        return {
          invoiceId: byNumber.id,
          invoiceNumber: byNumber.detail.invoice_number,
          status: byNumber.status,
          amount: byNumber.amount.value,
          currency_code: byNumber.amount.currency_code,
          matchedVia: "transaction_subject",
        };
      }
    }
  }
  // Otherwise: buyer email + currency + amount must all agree.
  const buyerEmail = dispute.disputed_transactions[0]?.buyer.email_address?.toLowerCase();
  if (!buyerEmail) return null;
  const byBuyerAndAmount = invoices.find(
    (i) =>
      i.primary_recipients[0]?.billing_info.email_address.toLowerCase() === buyerEmail &&
      i.amount.currency_code === dispute.amount.currency_code &&
      i.amount.value === dispute.amount.value,
  );
  if (!byBuyerAndAmount) return null;
  return {
    invoiceId: byBuyerAndAmount.id,
    invoiceNumber: byBuyerAndAmount.detail.invoice_number,
    status: byBuyerAndAmount.status,
    amount: byBuyerAndAmount.amount.value,
    currency_code: byBuyerAndAmount.amount.currency_code,
    matchedVia: "buyer_and_amount",
  };
}

/* ------------------------------------------------------------------ */
/* Builder                                                             */
/* ------------------------------------------------------------------ */

function daysBetween(referenceDate: string, date: string): number {
  const from = Date.parse(`${referenceDate.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

export function buildDisputeEvidenceSummary(input: {
  dispute: Dispute;
  transactions: Transaction[];
  invoices: Invoice[];
  /** yyyy-mm-dd reference "today" (injectable for tests). */
  referenceDate: string;
}): DisputeEvidenceSummary {
  const { dispute, referenceDate } = input;
  const txn0 = dispute.disputed_transactions[0];
  const buyerName = txn0?.buyer.name ?? "";
  const buyerEmail = txn0?.buyer.email_address ?? "";
  const sellerTransactionId = txn0?.seller_transaction_id ?? "";
  const reasonLabel = humanizeDisputeReason(dispute.reason);
  const isOpen = dispute.status !== "RESOLVED";
  const daysRemaining = dispute.response_due_date
    ? daysBetween(referenceDate, dispute.response_due_date)
    : null;
  const urgency: DisputeUrgency = !isOpen
    ? "resolved"
    : daysRemaining !== null && daysRemaining < 0
      ? "overdue"
      : daysRemaining !== null && daysRemaining <= 3
        ? "due_soon"
        : "open";

  const matchedTransaction = matchTransaction(dispute, input.transactions);
  const matchedInvoice = matchInvoice(dispute, input.invoices, matchedTransaction);

  const facts: string[] = [
    `Buyer ${buyerName || "(unnamed)"}${buyerEmail ? ` <${buyerEmail}>` : ""} opened dispute ${dispute.dispute_id} on ${dispute.create_time.slice(0, 10)}.`,
    `Reason: ${reasonLabel} (${dispute.reason}); lifecycle stage ${dispute.dispute_life_cycle_stage}; status ${dispute.status}.`,
    `Amount in dispute: ${dispute.amount.currency_code} ${dispute.amount.value}.`,
  ];
  if (sellerTransactionId) facts.push(`Seller transaction id: ${sellerTransactionId}.`);
  if (dispute.response_due_date) {
    facts.push(
      `Seller response deadline: ${dispute.response_due_date}` +
        (daysRemaining !== null
          ? daysRemaining < 0
            ? ` — ${Math.abs(daysRemaining)} day(s) past due at ${referenceDate}.`
            : ` — ${daysRemaining} day(s) remaining at ${referenceDate}.`
          : "."),
    );
  }
  if (matchedTransaction) {
    facts.push(
      `Transaction Search holds a matching record: ${matchedTransaction.transactionId} (${matchedTransaction.eventCode}), ` +
        `${matchedTransaction.currency_code} ${matchedTransaction.amount}, status ${matchedTransaction.status}, ${matchedTransaction.date.slice(0, 10)}` +
        (matchedTransaction.subject ? ` — "${matchedTransaction.subject}".` : "."),
    );
  }
  if (matchedInvoice) {
    facts.push(
      `Matching invoice on file: ${matchedInvoice.invoiceNumber} (${matchedInvoice.invoiceId}), status ${matchedInvoice.status}, ` +
        `${matchedInvoice.currency_code} ${matchedInvoice.amount} (matched via ${matchedInvoice.matchedVia === "transaction_subject" ? "the transaction subject" : "buyer email + amount"}).`,
    );
  }
  if (dispute.sample) {
    facts.push("This dispute is seeded sample data (flagged sample: true), not a live PayPal record.");
  }

  const checklist: EvidenceChecklistItem[] = [
    {
      label: "Dispute record from PayPal",
      present: true,
      detail: `${dispute.dispute_id} — ${reasonLabel}, ${dispute.amount.currency_code} ${dispute.amount.value}.`,
    },
    {
      label: "Matching seller transaction (Transaction Search)",
      present: matchedTransaction !== null,
      detail: matchedTransaction
        ? `${matchedTransaction.transactionId} matches the dispute's seller transaction id.`
        : sellerTransactionId
          ? `No Transaction Search row carries the id ${sellerTransactionId}.`
          : "The dispute names no seller transaction id to match.",
    },
    {
      label: "Matching invoice on file",
      present: matchedInvoice !== null,
      detail: matchedInvoice
        ? `Invoice ${matchedInvoice.invoiceNumber}, status ${matchedInvoice.status}.`
        : "No invoice matches this dispute by transaction subject or by buyer email + amount.",
    },
    {
      label: "Seller response deadline known",
      present: dispute.response_due_date !== undefined,
      detail: dispute.response_due_date
        ? `Respond by ${dispute.response_due_date}.`
        : "PayPal provided no response_due_date for this dispute.",
    },
    {
      label: "Delivery / fulfilment proof",
      present: false,
      detail:
        "LedgerPilot holds no shipping or fulfilment records — attach tracking, delivery confirmation, or service-completion evidence by hand. This draft never asserts delivery.",
    },
  ];

  const gaps: string[] = checklist
    .filter((item) => !item.present)
    .map((item) =>
      item.label === "Delivery / fulfilment proof"
        ? "Delivery / fulfilment proof: attach tracking or service-completion evidence — LedgerPilot cannot supply this."
        : `${item.label}: not found in the seller's records available to LedgerPilot.`,
    );
  if (urgency === "overdue") {
    gaps.unshift("This dispute is past its seller-response deadline — respond in PayPal immediately.");
  }

  const headline =
    `${dispute.sample ? "Sample dispute — " : ""}${dispute.status}: ${buyerName || "Buyer"} claims ` +
    `${dispute.amount.currency_code} ${dispute.amount.value} — ${reasonLabel}` +
    (isOpen && dispute.response_due_date
      ? urgency === "overdue"
        ? ` (response overdue by ${Math.abs(daysRemaining ?? 0)} day(s))`
        : ` (respond by ${dispute.response_due_date.slice(0, 10)})`
      : "");

  const draftLines = [
    "DRAFT SELLER RESPONSE — FOR REVIEW ONLY, NOT SUBMITTED",
    "",
    `Re: Dispute ${dispute.dispute_id}${dispute.sample ? " (seeded sample data — not a live PayPal record)" : ""}`,
    `Buyer: ${buyerName || "(unnamed)"}${buyerEmail ? ` <${buyerEmail}>` : ""}`,
    `Reason: ${reasonLabel} (${dispute.reason})`,
    `Amount in dispute: ${dispute.amount.currency_code} ${dispute.amount.value}`,
    ...(sellerTransactionId ? [`Seller transaction: ${sellerTransactionId}`] : []),
    ...(dispute.response_due_date ? [`Response deadline: ${dispute.response_due_date}`] : []),
    "",
    "What our records show:",
    ...facts.map((f) => `- ${f}`),
    "",
    "Evidence still to attach before responding:",
    ...(gaps.length > 0 ? gaps.map((g) => `- ${g}`) : ["- None identified from the records available to LedgerPilot."]),
    "",
    "Note: this draft was assembled deterministically by LedgerPilot from the dispute record, " +
      "Transaction Search, and the seller's invoices. LedgerPilot's Disputes integration is read-only — " +
      "review this draft, attach the missing evidence, and submit the response in PayPal.",
  ];

  return {
    disputeId: dispute.dispute_id,
    sample: dispute.sample === true,
    status: dispute.status,
    stage: dispute.dispute_life_cycle_stage,
    reasonCode: dispute.reason,
    reasonLabel,
    buyerName,
    buyerEmail,
    sellerTransactionId,
    amount: dispute.amount.value,
    currency_code: dispute.amount.currency_code,
    createdAt: dispute.create_time,
    responseDueDate: dispute.response_due_date,
    daysRemaining,
    isOpen,
    urgency,
    headline,
    facts,
    checklist,
    gaps,
    matchedTransaction,
    matchedInvoice,
    draftResponse: draftLines.join("\n"),
    disclaimer: EVIDENCE_DISCLAIMER,
  };
}

/* ------------------------------------------------------------------ */
/* Adapter-backed lookup (API route + tests share this path)           */
/* ------------------------------------------------------------------ */

export async function getDisputeEvidenceSummary(
  client: PayPalClient,
  disputeId: string,
  referenceDate: string,
): Promise<DisputeEvidenceSummary> {
  const disputes = await client.listDisputes();
  const dispute = disputes.find((d) => d.dispute_id === disputeId);
  if (!dispute) {
    throw new DisputeEvidenceError(
      `Dispute ${disputeId} not found — no evidence summary was drafted.`,
      404,
    );
  }
  const [transactions, invoices] = await Promise.all([
    client.listTransactions(),
    client.listInvoices(),
  ]);
  return buildDisputeEvidenceSummary({ dispute, transactions, invoices, referenceDate });
}
