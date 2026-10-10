/**
 * Resource-shaped plan drafts — the `POST /api/paypal/invoices|orders|payouts`
 * wrappers CONCEPT.md §3.1 lists.
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
 */

import type { ActionPlan, ActionStep, CurrencyCode, Money, Party } from "../types";
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

export interface PayoutDraftInput {
  recipientName?: unknown;
  recipientEmail?: unknown;
  amount?: unknown;
  currency?: unknown;
  note?: unknown;
  /** Invoice id this payout waits for: gated on INVOICING.INVOICE.PAID for exactly that invoice. */
  payWhenInvoicePaid?: unknown;
}

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

function parseMoney(amount: unknown, currency: unknown): Money {
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

/** Draft a `draft_payout` plan (POST /api/paypal/payouts). Nothing is paid out. */
export function draftPayoutPlan(input: PayoutDraftInput, options: DraftOptions = {}): ActionPlan {
  const recipient = parseRecipient(input.recipientName, input.recipientEmail, options.contacts);
  const amount = parseMoney(input.amount, input.currency);
  const note = optionalText(input.note, "note") ?? `Payout to ${recipient.name} (LedgerPilot plan)`;
  const gateRaw = input.payWhenInvoicePaid;
  const gate = gateRaw === undefined || gateRaw === null || gateRaw === "" ? undefined : requireText(gateRaw, "payWhenInvoicePaid");
  const step: ActionStep = {
    type: "draft_payout",
    description: `Pay out ${amount.currency_code} ${amount.value} to ${recipient.name}${gate ? " — only after the invoice payment lands" : ""}`,
    paypalCall: { method: "POST", path: "/v1/payments/payouts" },
    payload: { recipient, amount, note },
  };
  if (gate) step.trigger = { on: "INVOICING.INVOICE.PAID", resourceId: gate };
  return basePlan(`API draft: payout ${amount.currency_code} ${amount.value} to ${recipient.name}`, step, options);
}
