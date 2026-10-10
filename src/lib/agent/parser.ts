/**
 * Deterministic brief parser — the LedgerPilot agent's default brain.
 *
 * Converts a plain-English money brief into a typed ActionPlan
 * (CONCEPT.md §3.1). No LLM, no network, no keys: the same brief with
 * the same reference date always produces the same plan, which is what
 * makes the approval gate auditable. The optional LLM adapter
 * (./llm.ts) is only a fallback for briefs this parser cannot read, and
 * its output is validated and converted by deterministic code before it
 * can become a plan — plans from this parser are marked
 * `source: "deterministic"`.
 *
 * Supported brief shapes (see tests/agent-core.test.ts):
 *   "Invoice Ana $450 for logo work, due Friday"
 *   "Invoice Ana $450 for brand work, due Friday. When it lands, pay $200 to my contractor Marco."
 *   "Pay $200 to Marco for hosting help"            (immediate payout)
 *   "Pay Marco $200"                                (immediate payout)
 *   "Sell a studio cable pack for $59"              (Orders v2 checkout)
 *   "Remind Ana about invoice LP-000123"           (reminder draft)
 */

import type { ActionPlan, ActionStep, CurrencyCode, Party } from "../types";

export class BriefParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BriefParseError";
  }
}

/** Fictional demo contacts (CONCEPT.md examples). Unknown names fall back to a slug address. */
export const DEMO_CONTACTS: Record<string, Party> = {
  ana: { name: "Ana", email_address: "ana@example.com" },
  marco: { name: "Marco", email_address: "marco@example.com" },
  sam: { name: "Sam Rivera", email_address: "sam@example.com" },
};

export function resolveContact(name: string, contacts: Record<string, Party> = DEMO_CONTACTS): Party {
  const known = contacts[name.toLowerCase()];
  if (known) return known;
  const clean = name.trim();
  return { name: clean, email_address: `${clean.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@example.com` };
}

export interface ParseOptions {
  /** Reference "now" for relative due dates — injectable for deterministic tests / Judge Mode. */
  now?: Date;
  contacts?: Record<string, Party>;
  planId?: string;
}

let planSeq = 0;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Parse "Friday" / "in 5 days" / "tomorrow" / "2026-10-16" into an ISO date, or undefined. */
export function parseDueDate(text: string, now: Date): string | undefined {
  const t = text.trim().toLowerCase().replace(/[.\s]+$/, "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (t === "tomorrow") return fmtDate(addDays(now, 1));
  if (t === "today") return fmtDate(now);
  const inDays = t.match(/^in (\d+) days?$/);
  if (inDays) return fmtDate(addDays(now, Number(inDays[1])));
  const weekday = WEEKDAYS.indexOf(t);
  if (weekday >= 0) {
    const delta = (weekday - now.getUTCDay() + 7) % 7;
    return fmtDate(addDays(now, delta));
  }
  return undefined;
}

function money(symbolOrCode: string | undefined, amount: string): { currency_code: CurrencyCode; value: string } {
  const currency_code: CurrencyCode =
    symbolOrCode === "€" || symbolOrCode === "EUR" ? "EUR" : symbolOrCode === "£" || symbolOrCode === "GBP" ? "GBP" : "USD";
  return { currency_code, value: Number(amount.replace(/,/g, "")).toFixed(2) };
}

interface Found {
  index: number;
  step: ActionStep;
}

export function parseBrief(brief: string, options: ParseOptions = {}): ActionPlan {
  const now = options.now ?? new Date();
  const contacts = options.contacts ?? DEMO_CONTACTS;
  const text = brief.trim();
  if (!text) throw new BriefParseError("The brief is empty — describe the money action in plain English.");
  const found: Found[] = [];

  /* --- Invoice: "Invoice Ana $450 for logo work, due Friday" --- */
  const invoiceMatch = text.match(
    /(?:invoice|bill)\s+([A-Z][a-zA-Z]+)\s+([$€£])?\s*([\d,]+(?:\.\d{1,2})?)\s*(USD|EUR|GBP)?\s+for\s+([^.;]+)/i,
  );
  let invoiceStepIndex = -1;
  if (invoiceMatch) {
    const [, name, symbol, amount, code, rest] = invoiceMatch;
    const [descRaw, dueRaw] = rest!.split(/\s*,?\s+due\s+/i);
    const amt = money(symbol ?? code, amount!);
    const recipient = resolveContact(name!, contacts);
    const dueDate = dueRaw ? parseDueDate(dueRaw, now) : undefined;
    invoiceStepIndex = invoiceMatch.index ?? 0;
    found.push({
      index: invoiceStepIndex,
      step: {
        type: "create_invoice",
        description: `Invoice ${recipient.name} ${amt.currency_code} ${amt.value} for ${descRaw!.trim()}${dueDate ? `, due ${dueDate}` : ""} — create the draft and send it`,
        paypalCall: { method: "POST", path: "/v2/invoicing/invoices (+ /send)" },
        payload: {
          recipient,
          items: [{ name: descRaw!.trim(), quantity: "1", unit_amount: amt }],
          dueDate,
        },
      },
    });
  }

  /* --- Payout: "pay $200 to my contractor Marco" / "pay Marco $200" --- */
  const payoutMatch =
    text.match(/pay\s+(?:out\s+)?([$€£])?\s*([\d,]+(?:\.\d{1,2})?)\s*(USD|EUR|GBP)?\s+to\s+(?:my\s+(?:contractor|supplier|freelancer)\s+)?([A-Z][a-zA-Z]+)/i) ??
    text.match(/pay\s+([A-Z][a-zA-Z]+)\s+([$€£])?\s*([\d,]+(?:\.\d{1,2})?)\s*(USD|EUR|GBP)?/i);
  if (payoutMatch) {
    const toForm = payoutMatch[0].toLowerCase().includes(" to ");
    const name = (toForm ? payoutMatch[4] : payoutMatch[1])!;
    const symbol = (toForm ? payoutMatch[1] : payoutMatch[2]) as string | undefined;
    const amount = (toForm ? payoutMatch[2] : payoutMatch[3])!;
    const code = (toForm ? payoutMatch[3] : payoutMatch[4]) as string | undefined;
    const amt = money(symbol ?? code, amount);
    const recipient = resolveContact(name, contacts);
    // Triggered when the brief gates the payout on money arriving
    // ("when it lands", "after the invoice is paid", …).
    const gated = /when\s+(?:it|the invoice|the payment)\s+(?:lands|arrives|clears|is paid)|after\s+(?:it|the invoice|the payment)\s+(?:lands|is paid)/i.test(text);
    const step: ActionStep = {
      type: "draft_payout",
      description: `Pay out ${amt.currency_code} ${amt.value} to ${recipient.name}${gated ? " — only after the invoice payment lands" : ""}`,
      paypalCall: { method: "POST", path: "/v1/payments/payouts" },
      payload: { recipient, amount: amt, note: `Payout to ${recipient.name} (LedgerPilot plan)` },
    };
    if (gated) step.trigger = { on: "INVOICING.INVOICE.PAID" };
    found.push({ index: payoutMatch.index ?? 0, step });
  }

  /* --- Order: "Sell a studio cable pack for $59" --- */
  const orderMatch =
    text.match(/sell\s+(?:an?\s+)?([^.;$]+?)\s+for\s+([$€£])?\s*([\d,]+(?:\.\d{1,2})?)\s*(USD|EUR|GBP)?/i) ??
    text.match(/create\s+(?:an?\s+)?order\s*(?:for\s+)?(?:an?\s+)?([^.;$]+?)\s+(?:for|at)\s+([$€£])?\s*([\d,]+(?:\.\d{1,2})?)\s*(USD|EUR|GBP)?/i);
  if (orderMatch && !invoiceMatch) {
    const [, desc, symbol, amount, code] = orderMatch;
    const amt = money(symbol ?? code, amount!);
    found.push({
      index: orderMatch.index ?? 0,
      step: {
        type: "create_order",
        description: `Create a checkout order: ${desc!.trim()} — ${amt.currency_code} ${amt.value}`,
        paypalCall: { method: "POST", path: "/v2/checkout/orders" },
        payload: { description: desc!.trim(), amount: amt },
      },
    });
  }

  /* --- Reminder: "Remind Ana about invoice LP-000123" --- */
  const reminderMatch = text.match(/remind\s+([A-Z][a-zA-Z]+)(?:\s+about\s+(?:invoice\s+)?(\S+))?/i);
  if (reminderMatch && !invoiceMatch) {
    const [, name, ref] = reminderMatch;
    const recipient = resolveContact(name!, contacts);
    found.push({
      index: reminderMatch.index ?? 0,
      step: {
        type: "send_reminder",
        description: `Draft a payment reminder to ${recipient.name}${ref ? ` about invoice ${ref}` : ""}`,
        paypalCall: { method: "POST", path: "/v2/invoicing/invoices/:id/remind" },
        payload: { recipient, invoiceRef: ref ?? null },
      },
    });
  }

  if (found.length === 0) {
    throw new BriefParseError(
      `No money action found in: "${text}". Try "Invoice Ana $450 for logo work, due Friday" or "Pay $200 to Marco".`,
    );
  }

  found.sort((a, b) => a.index - b.index);
  planSeq += 1;
  return {
    id: options.planId ?? `plan-${String(planSeq).padStart(4, "0")}`,
    brief: text,
    steps: found.map((f) => f.step),
    status: "pending_approval",
    createdAt: now.toISOString(),
    source: "deterministic",
  };
}
