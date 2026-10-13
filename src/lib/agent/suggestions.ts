/**
 * Next-action suggestions — the agent drafting its *next* plan.
 *
 * CONCEPT.md §3.1's data flow ends with: local state updates, the grids
 * re-render, and "the agent drafts the *next* action (reminder /
 * payout) as a new pending plan". The payout half of that sentence has
 * always existed as the trigger-gated step inside the originating plan.
 * The reminder half did not: an overdue invoice sat in the console
 * flagged red, but nothing ever proposed the reminder — the seller had
 * to notice, open the reminder form, and draft it by hand. This module
 * is that missing draft step.
 *
 * Doctrine, identical to every other plan source:
 *  - Deterministic only. The rule is the read model's own overdue
 *    definition (an open invoice — SENT / SCHEDULED / PARTIALLY_PAID —
 *    whose due date is before the reference date), applied in a stable
 *    order (most overdue first, adapter list order breaks ties). No
 *    LLM is consulted, no key is needed.
 *  - Draft only, through the gate. A suggestion is a `send_reminder`
 *    plan in `pending_approval` (source `"suggested"`), built from the
 *    resource drafts' reminder step so its payload and PayPal call are
 *    identical to a hand-drafted reminder. Nothing is sent until the
 *    seller approves and executes it like any other plan.
 *  - Never nag twice. An invoice is skipped when a reminder for it was
 *    already sent (the executor's `reminded: true` audit record), or
 *    when any reminder plan already targets it in any status other
 *    than `failed` — a pending suggestion is not duplicated, an
 *    approved/executed one is not re-proposed, and a plan the seller
 *    rejected is not quietly re-drafted. A `failed` plan is the one
 *    exception: its reminder never went out, so the suggestion stands.
 *  - The explicit reference is the invoice number, so the executor's
 *    deterministic resolution lands on exactly this invoice — never
 *    on "the recipient's most-overdue", which could be a different
 *    invoice by execution time.
 */

import type { ActionPlan, Invoice, Money } from "../types";
import type { PayPalClient } from "../paypal/client";
import { draftReminderPlan } from "./drafts";
import type { LedgerStore } from "./store";

/** Open statuses, mirroring the read model's overdue definition. */
const OPEN_STATUSES: ReadonlySet<Invoice["status"]> = new Set(["SENT", "SCHEDULED", "PARTIALLY_PAID"]);

export class SuggestionError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "SuggestionError";
  }
}

export interface SuggestedReminder {
  plan: ActionPlan;
  invoiceId: string;
  invoiceNumber: string;
  recipientName: string;
  dueDate: string;
  /** Amount still due on the invoice, in its own currency. */
  dueAmount: Money;
}

export interface SkippedSuggestion {
  invoiceId: string;
  invoiceNumber: string;
  reason: "already_reminded" | "reminder_plan_exists";
  /** The covering plan, when the skip is `reminder_plan_exists`. */
  planId?: string;
  planStatus?: ActionPlan["status"];
}

export interface SuggestNextActionsResult {
  /** yyyy-mm-dd the overdue test was applied at. */
  referenceDate: string;
  /** Overdue open invoices found (drafted + skipped). */
  overdueCount: number;
  drafted: SuggestedReminder[];
  skipped: SkippedSuggestion[];
}

export interface SuggestNextActionsOptions {
  /** Injectable reference date (yyyy-mm-dd); defaults to today (UTC). */
  referenceDate?: string;
  now?: Date;
}

let suggestedPlanSeq = 0;

function nextSuggestedPlanId(): string {
  suggestedPlanSeq += 1;
  return `plan-suggested-${String(suggestedPlanSeq).padStart(4, "0")}`;
}

/** Validate an optional reference date the same way the drafts validate due dates. */
export function resolveReferenceDate(raw: unknown, now: Date): string {
  if (raw === undefined || raw === null || raw === "") return now.toISOString().slice(0, 10);
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new SuggestionError("'referenceDate' must be an ISO date (yyyy-mm-dd)");
  }
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new SuggestionError("'referenceDate' must be a real calendar date (yyyy-mm-dd)");
  }
  return raw;
}

function invoiceEmail(invoice: Invoice): string {
  return (invoice.primary_recipients[0]?.billing_info.email_address ?? "").toLowerCase();
}

/**
 * Does this plan's reminder step target this invoice? An explicit
 * reference matches by invoice id, invoice number, or detail
 * reference — the same three keys the executor resolves by. A
 * reference-less reminder resolves at execution by recipient email,
 * so it covers every open invoice of that recipient.
 */
function reminderStepTargets(plan: ActionPlan, invoice: Invoice): boolean {
  for (const step of plan.steps) {
    if (step.type !== "send_reminder") continue;
    const payload = step.payload as { recipient?: { email_address?: unknown }; invoiceRef?: unknown };
    const ref = typeof payload.invoiceRef === "string" && payload.invoiceRef ? payload.invoiceRef : null;
    if (ref) {
      if (ref === invoice.id || ref === invoice.detail.invoice_number || ref === invoice.detail.reference) return true;
    } else if (typeof payload.recipient?.email_address === "string" && payload.recipient.email_address.toLowerCase() === invoiceEmail(invoice)) {
      return true;
    }
  }
  return false;
}

/**
 * Scan the adapter's invoices for overdue open ones and draft one
 * pending-approval reminder plan per uncovered invoice. Returns the
 * drafted plans plus the per-invoice skip reasons — a run that drafts
 * nothing still says why.
 */
export async function suggestNextActions(
  client: PayPalClient,
  store: LedgerStore,
  options: SuggestNextActionsOptions = {},
): Promise<SuggestNextActionsResult> {
  const now = options.now ?? new Date();
  const referenceDate = resolveReferenceDate(options.referenceDate, now);
  const invoices = await client.listInvoices();
  const overdue = invoices
    .filter((inv) => {
      const dueDate = inv.detail.payment_term?.due_date;
      return OPEN_STATUSES.has(inv.status) && !!dueDate && dueDate < referenceDate;
    })
    .sort((a, b) => {
      const da = a.detail.payment_term!.due_date!;
      const db = b.detail.payment_term!.due_date!;
      return da < db ? -1 : da > db ? 1 : 0;
    });

  const plans = store.listPlans();
  const activity = store.listActivity();
  const drafted: SuggestedReminder[] = [];
  const skipped: SkippedSuggestion[] = [];

  for (const invoice of overdue) {
    const invoiceNumber = invoice.detail.invoice_number;
    if (activity.some((r) => r.detail?.reminded === true && r.detail?.invoiceId === invoice.id)) {
      skipped.push({ invoiceId: invoice.id, invoiceNumber, reason: "already_reminded" });
      continue;
    }
    const covering = plans.find((p) => p.status !== "failed" && reminderStepTargets(p, invoice));
    if (covering) {
      skipped.push({ invoiceId: invoice.id, invoiceNumber, reason: "reminder_plan_exists", planId: covering.id, planStatus: covering.status });
      continue;
    }
    const recipient = invoice.primary_recipients[0]?.billing_info;
    const draft = draftReminderPlan(
      {
        recipientName: recipient?.name ?? "",
        recipientEmail: recipient?.email_address,
        invoiceRef: invoiceNumber,
      },
      { now },
    );
    const dueDate = invoice.detail.payment_term!.due_date!;
    const plan: ActionPlan = {
      ...draft,
      id: nextSuggestedPlanId(),
      source: "suggested",
      brief:
        `Suggestion: payment reminder to ${recipient?.name ?? "the recipient"} about overdue invoice ${invoiceNumber} ` +
        `(${invoice.due_amount.currency_code} ${invoice.due_amount.value} still due, due ${dueDate})`,
    };
    store.addPlan(plan);
    drafted.push({
      plan,
      invoiceId: invoice.id,
      invoiceNumber,
      recipientName: recipient?.name ?? "",
      dueDate,
      dueAmount: { ...invoice.due_amount },
    });
  }

  return { referenceDate, overdueCount: overdue.length, drafted, skipped };
}
