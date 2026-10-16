/**
 * Payout batch builder — pure view-model logic for the console's
 * batch form (CONCEPT.md §3.1: "payout batch builder: agent-drafted
 * batch, per-line validation, approval release").
 *
 * The data path already exists and is the only path this form uses:
 *   POST /api/paypal/payouts { items: [...] }
 *     → draftPayoutPlan validates every line again server-side and
 *       drafts a `pending_approval` plan (nothing moves)
 *   POST /api/agent/approve + /api/agent/execute
 *     → the ordinary approval gate releases the batch as exactly one
 *       Payouts call.
 *
 * The validation here mirrors the server's rules (src/lib/agent/
 * drafts.ts) so the form can name the failing line and field before
 * the round-trip — it is a UX mirror, never the enforcement point:
 * the server re-validates every line and its errors surface verbatim.
 * Money is totalled per currency and never summed across currencies,
 * exactly like the drafts module and the console read models.
 */

import { MAX_PAYOUT_BATCH_ITEMS } from "../agent/drafts";
import type { CurrencyCode, Money } from "../types";

export { MAX_PAYOUT_BATCH_ITEMS };

export const BATCH_CURRENCIES: CurrencyCode[] = ["USD", "EUR", "GBP"];

/** Same hard ceiling the server enforces (drafts.ts / llm.ts). */
export const MAX_BATCH_AMOUNT = 100_000;
const MAX_TEXT = 500;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/* ------------------------------------------------------------------ */
/* Form state                                                          */
/* ------------------------------------------------------------------ */

/** One form line. Every field is the raw input string; parsing and
 * normalisation happen in buildBatchRequestBody / the totals preview. */
export interface BatchLineForm {
  recipientName: string;
  recipientEmail: string;
  amount: string;
  currency: string;
  note: string;
}

export function emptyBatchLine(): BatchLineForm {
  return { recipientName: "", recipientEmail: "", amount: "", currency: "USD", note: "" };
}

/** Fictional demo lines only (the demo contact book names). Loading
 * the example must always produce a body the real server validator
 * accepts — the test suite pins that against draftPayoutPlan. */
export const EXAMPLE_BATCH_LINES: BatchLineForm[] = [
  { recipientName: "Marco", recipientEmail: "", amount: "200", currency: "USD", note: "Brand work share" },
  { recipientName: "Ana", recipientEmail: "", amount: "50.5", currency: "EUR", note: "" },
  { recipientName: "Sam Rivera", recipientEmail: "sam@example.com", amount: "25", currency: "USD", note: "" },
];

export function canAddLine(lineCount: number): boolean {
  return lineCount < MAX_PAYOUT_BATCH_ITEMS;
}

export function canRemoveLine(lineCount: number): boolean {
  return lineCount > 1;
}

export function addBatchLine(lines: BatchLineForm[]): BatchLineForm[] {
  if (!canAddLine(lines.length)) return lines;
  return [...lines, emptyBatchLine()];
}

export function removeBatchLine(lines: BatchLineForm[], index: number): BatchLineForm[] {
  if (!canRemoveLine(lines.length)) return lines;
  if (index < 0 || index >= lines.length) return lines;
  return lines.filter((_, i) => i !== index);
}

export function updateBatchLine(
  lines: BatchLineForm[],
  index: number,
  patch: Partial<BatchLineForm>,
): BatchLineForm[] {
  return lines.map((line, i) => (i === index ? { ...line, ...patch } : line));
}

/* ------------------------------------------------------------------ */
/* Validation (UX mirror of the server's per-line rules)               */
/* ------------------------------------------------------------------ */

export type BatchLineField = "recipientName" | "recipientEmail" | "amount" | "currency" | "note";

export interface BatchFieldError {
  /** Line index, or null for a form-level error (batch note / gate). */
  lineIndex: number | null;
  field: BatchLineField | "items" | "note" | "payWhenInvoicePaid";
  message: string;
}

export interface BatchFormOptions {
  note?: string;
  payWhenInvoicePaid?: string;
}

export interface BatchValidation {
  ok: boolean;
  errors: BatchFieldError[];
}

/** Parse a form amount the way the server does: commas stripped,
 * numeric strings accepted. Returns null when not a finite number. */
export function parseFormAmount(raw: string): number | null {
  const text = raw.trim().replace(/,/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function validateLine(line: BatchLineForm, lineIndex: number, errors: BatchFieldError[]): void {
  const push = (field: BatchFieldError["field"], message: string) =>
    errors.push({ lineIndex, field, message });

  const name = line.recipientName.trim();
  if (!name) push("recipientName", "'recipientName' is required and must be a non-empty string");
  else if (name.length > MAX_TEXT) push("recipientName", `'recipientName' must be at most ${MAX_TEXT} characters`);

  const email = line.recipientEmail.trim();
  if (email && !EMAIL_RE.test(email)) push("recipientEmail", "'recipientEmail' must be a valid email address");

  if (!line.amount.trim()) {
    push("amount", "'amount' is required and must be a number (or numeric string)");
  } else {
    const amount = parseFormAmount(line.amount);
    if (amount === null) push("amount", "'amount' is required and must be a number (or numeric string)");
    else if (amount <= 0) push("amount", "'amount' must be greater than zero");
    else if (Number(amount.toFixed(2)) <= 0)
      push("amount", "'amount' must be at least 0.01 — amounts are kept to two decimal places, so this rounds to 0.00");
    else if (amount > MAX_BATCH_AMOUNT) push("amount", `'amount' must not exceed ${MAX_BATCH_AMOUNT}`);
  }

  const currency = line.currency.trim().toUpperCase();
  if (currency && !BATCH_CURRENCIES.includes(currency as CurrencyCode)) {
    push("currency", "'currency' must be one of USD, EUR, GBP");
  }

  if (line.note.trim().length > MAX_TEXT) push("note", `'note' must be at most ${MAX_TEXT} characters`);
}

export function validateBatchForm(lines: BatchLineForm[], options: BatchFormOptions = {}): BatchValidation {
  const errors: BatchFieldError[] = [];
  if (lines.length === 0) {
    errors.push({ lineIndex: null, field: "items", message: "'items' must contain at least one payout line" });
  }
  if (lines.length > MAX_PAYOUT_BATCH_ITEMS) {
    errors.push({
      lineIndex: null,
      field: "items",
      message: `'items' must contain at most ${MAX_PAYOUT_BATCH_ITEMS} payout lines (got ${lines.length})`,
    });
  }
  lines.forEach((line, i) => validateLine(line, i, errors));
  if ((options.note ?? "").trim().length > MAX_TEXT) {
    errors.push({ lineIndex: null, field: "note", message: `'note' must be at most ${MAX_TEXT} characters` });
  }
  const gate = (options.payWhenInvoicePaid ?? "").trim();
  if (gate.length > MAX_TEXT) {
    errors.push({
      lineIndex: null,
      field: "payWhenInvoicePaid",
      message: `'payWhenInvoicePaid' must be at most ${MAX_TEXT} characters`,
    });
  }
  return { ok: errors.length === 0, errors };
}

/** First error message for one line+field, for inline rendering. */
export function lineFieldError(
  validation: BatchValidation,
  lineIndex: number,
  field: BatchLineField,
): string | null {
  return validation.errors.find((e) => e.lineIndex === lineIndex && e.field === field)?.message ?? null;
}

/* ------------------------------------------------------------------ */
/* Request body + live totals                                          */
/* ------------------------------------------------------------------ */

export interface BatchRequestItem {
  recipientName: string;
  recipientEmail?: string;
  amount: number;
  currency: CurrencyCode;
  note?: string;
}

export interface BatchRequestBody {
  items: BatchRequestItem[];
  note?: string;
  payWhenInvoicePaid?: string;
}

/**
 * Convert validated form lines into the POST /api/paypal/payouts
 * batch body. Amounts become numbers ("1,200" → 1200, "50.5" → 50.5 —
 * the server formats them to two decimals), currencies normalise to
 * upper case (blank → USD), and empty optional fields are omitted
 * rather than sent as empty strings.
 */
export function buildBatchRequestBody(lines: BatchLineForm[], options: BatchFormOptions = {}): BatchRequestBody {
  const items = lines.map((line) => {
    const item: BatchRequestItem = {
      recipientName: line.recipientName.trim(),
      amount: parseFormAmount(line.amount) ?? 0,
      currency: (line.currency.trim().toUpperCase() || "USD") as CurrencyCode,
    };
    const email = line.recipientEmail.trim();
    if (email) item.recipientEmail = email;
    const note = line.note.trim();
    if (note) item.note = note;
    return item;
  });
  const body: BatchRequestBody = { items };
  const note = (options.note ?? "").trim();
  if (note) body.note = note;
  const gate = (options.payWhenInvoicePaid ?? "").trim();
  if (gate) body.payWhenInvoicePaid = gate;
  return body;
}

/**
 * Per-currency totals over the lines whose amount and currency are
 * currently valid (the live preview while typing). Invalid lines are
 * skipped here — validation reports them separately; a preview must
 * never present a guessed total as fact.
 */
export function batchTotalsPreview(lines: BatchLineForm[]): Money[] {
  const byCurrency = new Map<CurrencyCode, number>();
  for (const line of lines) {
    const amount = parseFormAmount(line.amount);
    if (amount === null || amount <= 0 || amount > MAX_BATCH_AMOUNT) continue;
    const currency = (line.currency.trim().toUpperCase() || "USD") as CurrencyCode;
    if (!BATCH_CURRENCIES.includes(currency)) continue;
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + amount);
  }
  return [...byCurrency.entries()].map(([currency_code, sum]) => ({
    currency_code,
    value: sum.toFixed(2),
  }));
}

export function formatBatchTotals(totals: Money[]): string {
  if (totals.length === 0) return "no amounts yet";
  return totals.map((t) => `${t.currency_code} ${t.value}`).join(" + ");
}

/** One-line live summary, e.g. "3 lines · USD 225.00 + EUR 50.50 — gated on invoice INV2-000001". */
export function batchPreviewSummary(lines: BatchLineForm[], options: BatchFormOptions = {}): string {
  const count = `${lines.length} line${lines.length === 1 ? "" : "s"}`;
  const gate = (options.payWhenInvoicePaid ?? "").trim();
  return `${count} · ${formatBatchTotals(batchTotalsPreview(lines))}${gate ? ` — gated on invoice ${gate}` : ""}`;
}
