/**
 * Invoice form — pure view-model logic for the console's "New invoice"
 * form (CONCEPT.md §3.1: "/invoices — invoice list + detail"; §3.2
 * step 2, the invoice leg of the demo spine).
 *
 * The structured data path already exists and is the only path this
 * form uses, exactly like the sell form and the payout batch builder:
 *   POST /api/paypal/invoices { recipientName, amount, description,
 *     currency?, recipientEmail?, dueDate?, note?, reference? }
 *     → draftInvoicePlan validates again server-side and drafts a
 *       `pending_approval` plan (nothing is created or sent)
 *   POST /api/agent/approve + /api/agent/execute
 *     → the ordinary approval gate creates and sends the invoice; it
 *       then appears in the Invoices grid above this form.
 *
 * Until this form existed, that draft wrapper was reachable only via
 * a natural-language invoice brief or curl — Invoicing, the primary
 * leg of the demo spine, was the one money surface with no structured
 * form, while Orders had the sell form and Payouts the batch builder.
 * The validation here mirrors the server's rules (src/lib/agent/
 * drafts.ts) so the form can name the failing field before the
 * round-trip — it is a UX mirror, never the enforcement point: the
 * server re-validates and its errors surface verbatim.
 */

import type { CurrencyCode } from "../types";

export const INVOICE_CURRENCIES: CurrencyCode[] = ["USD", "EUR", "GBP"];

/** Same hard ceiling the server enforces (drafts.ts / llm.ts). */
export const MAX_INVOICE_AMOUNT = 100_000;
const MAX_TEXT = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ------------------------------------------------------------------ */
/* Form state                                                          */
/* ------------------------------------------------------------------ */

/** The invoice form. Every field is the raw input string; parsing and
 * normalisation happen in buildInvoiceRequestBody / the preview. */
export interface InvoiceFormState {
  recipientName: string;
  recipientEmail: string;
  description: string;
  amount: string;
  currency: string;
  dueDate: string;
  note: string;
  reference: string;
}

export function emptyInvoiceForm(): InvoiceFormState {
  return {
    recipientName: "",
    recipientEmail: "",
    description: "",
    amount: "",
    currency: "USD",
    dueDate: "",
    note: "",
    reference: "",
  };
}

/** Fictional demo invoice only — the invoice leg of the demo spine
 * (the Agent Command bar's canonical brief: Ana, $450, brand work,
 * due Friday 2026-10-16 at the Judge Mode reference date). Loading
 * the example must always produce a body the real server validator
 * accepts — the test suite pins that against draftInvoicePlan. */
export const EXAMPLE_INVOICE_FORM: InvoiceFormState = {
  recipientName: "Ana",
  recipientEmail: "",
  description: "Brand work",
  amount: "450",
  currency: "USD",
  dueDate: "2026-10-16",
  note: "",
  reference: "",
};

/* ------------------------------------------------------------------ */
/* Validation (UX mirror of the server's draft rules)                  */
/* ------------------------------------------------------------------ */

export type InvoiceField =
  | "recipientName"
  | "recipientEmail"
  | "description"
  | "amount"
  | "currency"
  | "dueDate"
  | "note"
  | "reference";

export interface InvoiceFieldError {
  field: InvoiceField;
  message: string;
}

export interface InvoiceValidation {
  ok: boolean;
  errors: InvoiceFieldError[];
}

/** Parse a form amount the way the server does: commas stripped,
 * numeric strings accepted. Returns null when not a finite number. */
export function parseInvoiceAmount(raw: string): number | null {
  const text = raw.trim().replace(/,/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** Mirror of the server's due-date rule: ISO shape, then a real
 * calendar date (2026-02-30 is rejected, never rolled over). */
function dueDateError(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "'dueDate' must be an ISO date (yyyy-mm-dd)";
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    return "'dueDate' must be a real calendar date (yyyy-mm-dd)";
  }
  return null;
}

export function validateInvoiceForm(form: InvoiceFormState): InvoiceValidation {
  const errors: InvoiceFieldError[] = [];
  const push = (field: InvoiceField, message: string) => errors.push({ field, message });

  const recipientName = form.recipientName.trim();
  if (!recipientName) push("recipientName", "'recipientName' is required and must be a non-empty string");
  else if (recipientName.length > MAX_TEXT) push("recipientName", `'recipientName' must be at most ${MAX_TEXT} characters`);

  const recipientEmail = form.recipientEmail.trim();
  if (recipientEmail) {
    if (recipientEmail.length > MAX_TEXT) push("recipientEmail", `'recipientEmail' must be at most ${MAX_TEXT} characters`);
    else if (!EMAIL_RE.test(recipientEmail)) push("recipientEmail", "'recipientEmail' must be a valid email address");
  }

  const description = form.description.trim();
  if (!description) push("description", "'description' is required and must be a non-empty string");
  else if (description.length > MAX_TEXT) push("description", `'description' must be at most ${MAX_TEXT} characters`);

  if (!form.amount.trim()) {
    push("amount", "'amount' is required and must be a number (or numeric string)");
  } else {
    const amount = parseInvoiceAmount(form.amount);
    if (amount === null) push("amount", "'amount' is required and must be a number (or numeric string)");
    else if (amount <= 0) push("amount", "'amount' must be greater than zero");
    else if (Number(amount.toFixed(2)) <= 0)
      push("amount", "'amount' must be at least 0.01 — amounts are kept to two decimal places, so this rounds to 0.00");
    else if (amount > MAX_INVOICE_AMOUNT) push("amount", `'amount' must not exceed ${MAX_INVOICE_AMOUNT}`);
  }

  const currency = form.currency.trim().toUpperCase();
  if (currency && !INVOICE_CURRENCIES.includes(currency as CurrencyCode)) {
    push("currency", "'currency' must be one of USD, EUR, GBP");
  }

  const due = dueDateError(form.dueDate);
  if (due) push("dueDate", due);

  if (form.note.trim().length > MAX_TEXT) push("note", `'note' must be at most ${MAX_TEXT} characters`);
  if (form.reference.trim().length > MAX_TEXT) push("reference", `'reference' must be at most ${MAX_TEXT} characters`);

  return { ok: errors.length === 0, errors };
}

/** First error message for one field, for inline rendering. */
export function invoiceFieldError(validation: InvoiceValidation, field: InvoiceField): string | null {
  return validation.errors.find((e) => e.field === field)?.message ?? null;
}

/* ------------------------------------------------------------------ */
/* Request body + live preview                                         */
/* ------------------------------------------------------------------ */

export interface InvoiceRequestBody {
  recipientName: string;
  amount: number;
  currency: CurrencyCode;
  description: string;
  recipientEmail?: string;
  dueDate?: string;
  note?: string;
  reference?: string;
}

/**
 * Convert a validated form into the POST /api/paypal/invoices body.
 * Amounts become numbers ("1,200" → 1200), currencies normalise to
 * upper case (blank → USD), and empty optional fields are omitted
 * rather than sent as empty strings (the server's optional-text rule
 * would reject an empty string).
 */
export function buildInvoiceRequestBody(form: InvoiceFormState): InvoiceRequestBody {
  const body: InvoiceRequestBody = {
    recipientName: form.recipientName.trim(),
    amount: parseInvoiceAmount(form.amount) ?? 0,
    currency: (form.currency.trim().toUpperCase() || "USD") as CurrencyCode,
    description: form.description.trim(),
  };
  const recipientEmail = form.recipientEmail.trim();
  if (recipientEmail) body.recipientEmail = recipientEmail;
  const dueDate = form.dueDate.trim();
  if (dueDate) body.dueDate = dueDate;
  const note = form.note.trim();
  if (note) body.note = note;
  const reference = form.reference.trim();
  if (reference) body.reference = reference;
  return body;
}

/**
 * One-line live summary, e.g. "Invoice Ana · USD 450.00 for Brand
 * work, due 2026-10-16" or "Invoice Ana · no amount yet". An invalid
 * amount is reported as such, never guessed — validation names it
 * separately; a preview must never present a guessed total as fact.
 */
export function invoicePreviewSummary(form: InvoiceFormState): string {
  const recipient = form.recipientName.trim() || "Unnamed recipient";
  const amount = parseInvoiceAmount(form.amount);
  if (amount === null || amount <= 0 || amount > MAX_INVOICE_AMOUNT) return `Invoice ${recipient} · no amount yet`;
  const currency = (form.currency.trim().toUpperCase() || "USD") as CurrencyCode;
  if (!INVOICE_CURRENCIES.includes(currency)) return `Invoice ${recipient} · no amount yet`;
  const description = form.description.trim();
  const dueDate = form.dueDate.trim();
  return (
    `Invoice ${recipient} · ${currency} ${amount.toFixed(2)}` +
    (description ? ` for ${description}` : "") +
    (dueDate && !dueDateError(form.dueDate) ? `, due ${dueDate}` : "")
  );
}
