/**
 * Resource-shaped plan drafts — the `POST /api/paypal/invoices|orders|payouts`
 * wrappers CONCEPT.md §3.1 lists, plus `POST /api/paypal/reminders` for
 * the fourth typed action (`send_reminder`), which §3.1's sketch folds
 * into the Invoicing surface rather than listing as its own wrapper.
 *
 * These wrappers are deliberately **not** a second execution path. The
 * executor's header states the product invariant: nothing executes
 * without a plan + approval record. A wrapper therefore does exactly
 * what the NL parser does — validate the input and draft a typed
 * `pending_approval` plan (marked `source: "api"`) whose step payloads
 * are identical in shape to the parser's, so the ordinary
 * approve → execute flow runs them unchanged. Even the REST API cannot
 * move money without the approval gate; that is the trust story, kept
 * in code rather than in prose.
 *
 * A payout draft may be gated on a specific invoice's payment
 * (`payWhenInvoicePaid`): the step carries the
 * `INVOICING.INVOICE.PAID` trigger pre-bound to that invoice id, so the
 * executor's resource-correlated resumption releases it only when
 * *that* invoice is paid — never on another invoice's event.
 *
 * A payout draft may also carry a whole batch (CONCEPT.md §3.1's
 * "payout batch builder: agent-drafted batch, per-line validation,
 * approval release"): `items` lists every line, each line is validated
 * on its own (errors name the line, e.g. `items[1].amount …`), and the
 * drafted step's payload is the batch itself — the executor pays it as
 * exactly one Payouts batch after approval, never line by line.
 */

import type { ActionPlan, ActionStep, CurrencyCode, Money, Party, PayoutItemInput } from "../types";
import { DEMO_CONTACTS, resolveContact } from "./parser";

export class DraftValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "DraftValidationError";
  }
}

const CURRENCIES: CurrencyCode[] = ["USD", "EUR", "GBP"];
/** Same hard ceiling the LLM extraction validator enforces (llm.ts). */
const MAX_AMOUNT = 100_000;
const MAX_TEXT = 500;

export interface InvoiceDraftInput {
  recipientName?: unknown;
  recipientEmail?: unknown;
  amount?: unknown;
  currency?: unknown;
  description?: unknown;
  dueDate?: unknown;
  note?: unknown;
  reference?: unknown;
}

export interface OrderDraftInput {
  description?: unknown;
  amount?: unknown;
  currency?: unknown;
  reference?: unknown;
}

export interface ReminderDraftInput {
  recipientName?: unknown;
  recipientEmail?: unknown;
  /** Invoice id, invoice number, or detail reference; omit to target the recipient's most-overdue open invoice. */
  invoiceRef?: unknown;
}

export interface PayoutDraftInput {
  recipientName?: unknown;
  recipientEmail?: unknown;
  amount?: unknown;
  currency?: unknown;
  note?: unknown;
  /**
   * Batch form: an array of per-line objects shaped like the single
   * form ({ recipientName, recipientEmail?, amount, currency?, note? }).
   * Mutually exclusive with the top-level recipientName/amount fields.
   */
  items?: unknown;
  /** Invoice id this payout waits for: gated on INVOICING.INVOICE.PAID for exactly that invoice. */
  payWhenInvoicePaid?: unknown;
}

/** One raw line of a batch payout draft (validated per line). */
export interface PayoutBatchLineInput {
  recipientName?: unknown;
  recipientEmail?: unknown;
  amount?: unknown;
  currency?: unknown;
  note?: unknown;
}

/** Most lines one drafted batch may carry (PayPal's own ceiling is far higher; this keeps a plan review readable). */
export const MAX_PAYOUT_BATCH_ITEMS = 25;

export interface DraftOptions {
  now?: Date;
  contacts?: Record<string, Party>;
  planId?: string;
}

let apiPlanSeq = 0;

function nextPlanId(explicit?: string): string {
  if (explicit) return explicit;
  apiPlanSeq += 1;
  return `plan-api-${String(apiPlanSeq).padStart(4, "0")}`;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DraftValidationError(`'${field}' is required and must be a non-empty string`);
  }
  const text = value.trim();
  if (text.length > MAX_TEXT) throw new DraftValidationError(`'${field}' must be at most ${MAX_TEXT} characters`);
  return text;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireText(value, field);
}

function parseAmount(value: unknown): string {
  const n = typeof value === "string" && value.trim() ? Number(value.replace(/,/g, "")) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new DraftValidationError("'amount' is required and must be a number (or numeric string)");
  }
  if (n <= 0) throw new DraftValidationError("'amount' must be greater than zero");
  if (n > MAX_AMOUNT) throw new DraftValidationError(`'amount' must not exceed ${MAX_AMOUNT}`);
  return n.toFixed(2);
}

function parseCurrency(value: unknown): CurrencyCode {
  if (value === undefined || value === null || value === "") return "USD";
  if (typeof value !== "string") throw new DraftValidationError("'currency' must be one of USD, EUR, GBP");
  const code = value.trim().toUpperCase() as CurrencyCode;
  if (!CURRENCIES.includes(code)) throw new DraftValidationError("'currency' must be one of USD, EUR, GBP");
  return code;
}

/**
 * Validate an amount + currency into a Money value (amount > 0, hard
 * cap, USD/EUR/GBP whitelist, two-decimal formatting). Exported so the
 * plan-amendment module (edit.ts) validates edited amounts through
 * exactly these rules — the money rules live in one place.
 */
export function parseMoney(amount: unknown, currency: unknown): Money {
  return { currency_code: parseCurrency(currency), value: parseAmount(amount) };
}

function parseRecipient(nameRaw: unknown, emailRaw: unknown, contacts?: Record<string, Party>): Party {
  const name = requireText(nameRaw, "recipientName");
  if (emailRaw !== undefined && emailRaw !== null && emailRaw !== "") {
    const email = requireText(emailRaw, "recipientEmail");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new DraftValidationError("'recipientEmail' must be a valid email address");
    }
    return { name, email_address: email };
  }
  return resolveContact(name, contacts ?? DEMO_CONTACTS);
}

/** Re-throw a line's validation error with its batch position named. */
function withLineContext<T>(lineIndex: number, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof DraftValidationError) {
      throw new DraftValidationError(`items[${lineIndex}]: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Validate one batch line into a payout item. The note falls back to
 * the batch-level note, then to the standard per-recipient default —
 * the same default the single-recipient draft uses.
 */
function parsePayoutLine(
  raw: unknown,
  lineIndex: number,
  batchNote: string | undefined,
  contacts?: Record<string, Party>,
): PayoutItemInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DraftValidationError(`items[${lineIndex}] must be an object with recipientName and amount`);
  }
  const line = raw as PayoutBatchLineInput;
  const recipient = withLineContext(lineIndex, () =>
    parseRecipient(line.recipientName, line.recipientEmail, contacts),
  );
  const amount = withLineContext(lineIndex, () => parseMoney(line.amount, line.currency));
  const note =
    withLineContext(lineIndex, () => optionalText(line.note, "note")) ??
    batchNote ??
    `Payout to ${recipient.name} (LedgerPilot plan)`;
  return { recipient, amount, note };
}

/** Per-currency totals for a batch, in first-seen currency order (money is never summed across currencies). Exported for edit.ts's description regeneration. */
export function batchTotals(items: PayoutItemInput[]): Money[] {
  const byCurrency = new Map<CurrencyCode, number>();
  for (const item of items) {
    byCurrency.set(item.amount.currency_code, (byCurrency.get(item.amount.currency_code) ?? 0) + Number(item.amount.value));
  }
  return [...byCurrency.entries()].map(([currency_code, sum]) => ({ currency_code, value: sum.toFixed(2) }));
}

/** "USD 450.00" — the money rendering every step description uses. Exported for edit.ts. */
export function formatMoney(money: Money): string {
  return `${money.currency_code} ${money.value}`;
}

/** ISO yyyy-mm-dd and a real calendar date (2026-02-30 is rejected). */
function parseDueDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = requireText(value, "dueDate");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new DraftValidationError("'dueDate' must be an ISO date (yyyy-mm-dd)");
  }
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new DraftValidationError("'dueDate' must be a real calendar date (yyyy-mm-dd)");
  }
  return text;
}

function basePlan(brief: string, step: ActionStep, options: DraftOptions): ActionPlan {
  return {
    id: nextPlanId(options.planId),
    brief,
    steps: [step],
    status: "pending_approval",
    createdAt: (options.now ?? new Date()).toISOString(),
    source: "api",
  };
}

/** Draft a `create_invoice` plan (POST /api/paypal/invoices). Nothing is sent. */
export function draftInvoicePlan(input: InvoiceDraftInput, options: DraftOptions = {}): ActionPlan {
  const recipient = parseRecipient(input.recipientName, input.recipientEmail, options.contacts);
  const amount = parseMoney(input.amount, input.currency);
  const description = requireText(input.description, "description");
  const dueDate = parseDueDate(input.dueDate);
  const note = optionalText(input.note, "note");
  const reference = optionalText(input.reference, "reference");
  const step: ActionStep = {
    type: "create_invoice",
    description: `Invoice ${recipient.name} ${amount.currency_code} ${amount.value} for ${description}${dueDate ? `, due ${dueDate}` : ""} — create the draft and send it`,
    paypalCall: { method: "POST", path: "/v2/invoicing/invoices (+ /send)" },
    payload: {
      recipient,
      items: [{ name: description, quantity: "1", unit_amount: amount }],
      dueDate,
      ...(note ? { note } : {}),
      ...(reference ? { reference } : {}),
    },
  };
  return basePlan(`API draft: invoice ${recipient.name} ${amount.currency_code} ${amount.value} for ${description}`, step, options);
}

/** Draft a `create_order` plan (POST /api/paypal/orders). Nothing is created yet. */
export function draftOrderPlan(input: OrderDraftInput, options: DraftOptions = {}): ActionPlan {
  const description = requireText(input.description, "description");
  const amount = parseMoney(input.amount, input.currency);
  const reference = optionalText(input.reference, "reference");
  const step: ActionStep = {
    type: "create_order",
    description: `Create a checkout order: ${description} — ${amount.currency_code} ${amount.value}`,
    paypalCall: { method: "POST", path: "/v2/checkout/orders" },
    payload: { description, amount, ...(reference ? { reference_id: reference } : {}) },
  };
  return basePlan(`API draft: checkout order "${description}" ${amount.currency_code} ${amount.value}`, step, options);
}

/**
 * Draft a `send_reminder` plan (POST /api/paypal/reminders). Nothing is
 * sent. The step payload is identical to the deterministic parser's
 * reminder step ({ recipient, invoiceRef }) — an explicit reference is
 * carried verbatim (the executor must match it to an invoice id,
 * invoice number, or detail reference, and fails the step when nothing
 * matches); with no reference the payload carries `invoiceRef: null`
 * and the executor resolves the recipient's most-overdue open invoice.
 */
export function draftReminderPlan(input: ReminderDraftInput, options: DraftOptions = {}): ActionPlan {
  const recipient = parseRecipient(input.recipientName, input.recipientEmail, options.contacts);
  const refRaw = input.invoiceRef;
  const ref =
    refRaw === undefined || refRaw === null || refRaw === "" ? undefined : requireText(refRaw, "invoiceRef");
  const step: ActionStep = {
    type: "send_reminder",
    description: `Send a payment reminder to ${recipient.name}${ref ? ` about invoice ${ref}` : " about their most-overdue open invoice"}`,
    paypalCall: { method: "POST", path: "/v2/invoicing/invoices/:id/remind" },
    payload: { recipient, invoiceRef: ref ?? null },
  };
  return basePlan(
    `API draft: payment reminder to ${recipient.name}${ref ? ` about invoice ${ref}` : ""}`,
    step,
    options,
  );
}

/** Draft a `draft_payout` plan (POST /api/paypal/payouts). Nothing is paid out. */
export function draftPayoutPlan(input: PayoutDraftInput, options: DraftOptions = {}): ActionPlan {
  const gateRaw = input.payWhenInvoicePaid;
  const gate = gateRaw === undefined || gateRaw === null || gateRaw === "" ? undefined : requireText(gateRaw, "payWhenInvoicePaid");
  const gateSuffix = gate ? " — only after the invoice payment lands" : "";

  if (input.items !== undefined && input.items !== null) {
    // Batch form — the §3.1 batch builder. The single-recipient fields
    // must not be mixed in: an ambiguous draft is rejected, never
    // resolved by guessing which shape the caller meant.
    if (input.recipientName !== undefined || input.recipientEmail !== undefined || input.amount !== undefined || input.currency !== undefined) {
      throw new DraftValidationError(
        "'items' (batch form) cannot be combined with the top-level recipientName/recipientEmail/amount/currency fields — put the currency on each line",
      );
    }
    if (!Array.isArray(input.items)) {
      throw new DraftValidationError("'items' must be an array of payout lines ({ recipientName, amount, currency?, note? })");
    }
    if (input.items.length === 0) {
      throw new DraftValidationError("'items' must contain at least one payout line");
    }
    if (input.items.length > MAX_PAYOUT_BATCH_ITEMS) {
      throw new DraftValidationError(`'items' must contain at most ${MAX_PAYOUT_BATCH_ITEMS} payout lines (got ${input.items.length})`);
    }
    const batchNote = optionalText(input.note, "note");
    const items = input.items.map((raw, i) => parsePayoutLine(raw, i, batchNote, options.contacts));
    const totals = batchTotals(items).map(formatMoney).join(" + ");
    const lines = items.map((i) => `${formatMoney(i.amount)} to ${i.recipient.name}`).join(", ");
    const step: ActionStep = {
      type: "draft_payout",
      description: `Pay out a batch of ${items.length}: ${lines} (total ${totals})${gateSuffix}`,
      paypalCall: { method: "POST", path: "/v1/payments/payouts" },
      payload: { items },
    };
    if (gate) step.trigger = { on: "INVOICING.INVOICE.PAID", resourceId: gate };
    return basePlan(`API draft: payout batch of ${items.length} (total ${totals})`, step, options);
  }

  const recipient = parseRecipient(input.recipientName, input.recipientEmail, options.contacts);
  const amount = parseMoney(input.amount, input.currency);
  const note = optionalText(input.note, "note") ?? `Payout to ${recipient.name} (LedgerPilot plan)`;
  const step: ActionStep = {
    type: "draft_payout",
    description: `Pay out ${amount.currency_code} ${amount.value} to ${recipient.name}${gateSuffix}`,
    paypalCall: { method: "POST", path: "/v1/payments/payouts" },
    payload: { recipient, amount, note },
  };
  if (gate) step.trigger = { on: "INVOICING.INVOICE.PAID", resourceId: gate };
  return basePlan(`API draft: payout ${amount.currency_code} ${amount.value} to ${recipient.name}`, step, options);
}
