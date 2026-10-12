/**
 * Sell form — pure view-model logic for the console's "Sell something"
 * form (CONCEPT.md §3.1: "/checkout — 'Sell something' flow: create an
 * Orders v2 checkout link, show buyer view"; §3.2 step 5).
 *
 * The structured data path already exists and is the only path this
 * form uses, exactly like the payout batch builder:
 *   POST /api/paypal/orders { description, amount, currency?, reference? }
 *     → draftOrderPlan validates again server-side and drafts a
 *       `pending_approval` plan (nothing is created)
 *   POST /api/agent/approve + /api/agent/execute
 *     → the ordinary approval gate creates the order; the Orders
 *       grid's Buyer view then surfaces its checkout link and the
 *       Capture action completes the buyer side.
 *
 * Until this form existed, that draft wrapper was reachable only via
 * a natural-language "sell" brief or curl — the §3.1 checkout sketch
 * had a buyer surface (the grid's Buyer view + Capture) but no
 * structured seller surface. The validation here mirrors the
 * server's rules (src/lib/agent/drafts.ts) so the form can name the
 * failing field before the round-trip — it is a UX mirror, never
 * the enforcement point: the server re-validates and its errors
 * surface verbatim.
 */

import type { CurrencyCode } from "../types";

export const SELL_CURRENCIES: CurrencyCode[] = ["USD", "EUR", "GBP"];

/** Same hard ceiling the server enforces (drafts.ts / llm.ts). */
export const MAX_SELL_AMOUNT = 100_000;
const MAX_TEXT = 500;

/* ------------------------------------------------------------------ */
/* Form state                                                          */
/* ------------------------------------------------------------------ */

/** The sell form. Every field is the raw input string; parsing and
 * normalisation happen in buildOrderRequestBody / the preview. */
export interface SellFormState {
  description: string;
  amount: string;
  currency: string;
  reference: string;
}

export function emptySellForm(): SellFormState {
  return { description: "", amount: "", currency: "USD", reference: "" };
}

/** Fictional demo sale only — the same sale the Agent Command bar's
 * "Sell a logo pack for $75" example brief drafts. Loading the
 * example must always produce a body the real server validator
 * accepts — the test suite pins that against draftOrderPlan. */
export const EXAMPLE_SELL_FORM: SellFormState = {
  description: "Logo pack — five social templates",
  amount: "75",
  currency: "USD",
  reference: "",
};

/* ------------------------------------------------------------------ */
/* Validation (UX mirror of the server's draft rules)                  */
/* ------------------------------------------------------------------ */

export type SellField = "description" | "amount" | "currency" | "reference";

export interface SellFieldError {
  field: SellField;
  message: string;
}

export interface SellValidation {
  ok: boolean;
  errors: SellFieldError[];
}

/** Parse a form amount the way the server does: commas stripped,
 * numeric strings accepted. Returns null when not a finite number. */
export function parseSellAmount(raw: string): number | null {
  const text = raw.trim().replace(/,/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export function validateSellForm(form: SellFormState): SellValidation {
  const errors: SellFieldError[] = [];
  const push = (field: SellField, message: string) => errors.push({ field, message });

  const description = form.description.trim();
  if (!description) push("description", "'description' is required and must be a non-empty string");
  else if (description.length > MAX_TEXT) push("description", `'description' must be at most ${MAX_TEXT} characters`);

  if (!form.amount.trim()) {
    push("amount", "'amount' is required and must be a number (or numeric string)");
  } else {
    const amount = parseSellAmount(form.amount);
    if (amount === null) push("amount", "'amount' is required and must be a number (or numeric string)");
    else if (amount <= 0) push("amount", "'amount' must be greater than zero");
    else if (amount > MAX_SELL_AMOUNT) push("amount", `'amount' must not exceed ${MAX_SELL_AMOUNT}`);
  }

  const currency = form.currency.trim().toUpperCase();
  if (currency && !SELL_CURRENCIES.includes(currency as CurrencyCode)) {
    push("currency", "'currency' must be one of USD, EUR, GBP");
  }

  if (form.reference.trim().length > MAX_TEXT) {
    push("reference", `'reference' must be at most ${MAX_TEXT} characters`);
  }

  return { ok: errors.length === 0, errors };
}

/** First error message for one field, for inline rendering. */
export function sellFieldError(validation: SellValidation, field: SellField): string | null {
  return validation.errors.find((e) => e.field === field)?.message ?? null;
}

/* ------------------------------------------------------------------ */
/* Request body + live preview                                         */
/* ------------------------------------------------------------------ */

export interface OrderRequestBody {
  description: string;
  amount: number;
  currency: CurrencyCode;
  reference?: string;
}

/**
 * Convert a validated form into the POST /api/paypal/orders body.
 * Amounts become numbers ("1,200" → 1200, "75.5" → 75.5 — the server
 * formats them to two decimals), currencies normalise to upper case
 * (blank → USD), and an empty optional reference is omitted rather
 * than sent as an empty string.
 */
export function buildOrderRequestBody(form: SellFormState): OrderRequestBody {
  const body: OrderRequestBody = {
    description: form.description.trim(),
    amount: parseSellAmount(form.amount) ?? 0,
    currency: (form.currency.trim().toUpperCase() || "USD") as CurrencyCode,
  };
  const reference = form.reference.trim();
  if (reference) body.reference = reference;
  return body;
}

/**
 * One-line live summary, e.g. "Logo pack — five social templates ·
 * USD 75.00" or "Untitled sale · no amount yet". An invalid amount
 * is reported as such, never guessed — validation names it
 * separately; a preview must never present a guessed total as fact.
 */
export function sellPreviewSummary(form: SellFormState): string {
  const description = form.description.trim() || "Untitled sale";
  const amount = parseSellAmount(form.amount);
  if (amount === null || amount <= 0 || amount > MAX_SELL_AMOUNT) return `${description} · no amount yet`;
  const currency = (form.currency.trim().toUpperCase() || "USD") as CurrencyCode;
  if (!SELL_CURRENCIES.includes(currency)) return `${description} · no amount yet`;
  return `${description} · ${currency} ${amount.toFixed(2)}`;
}
