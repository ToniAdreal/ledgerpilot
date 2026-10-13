/**
 * Agent Command bar — pure view-model logic for the console's
 * brief → plan review → approve / reject → execute flow.
 *
 * The component (`src/app/command-bar.tsx`) is a thin shell over these
 * helpers and the existing agent API routes:
 *   POST /api/agent/plan     — brief → typed plan (nothing executes)
 *   POST /api/agent/approve  — the approval gate
 *   POST /api/agent/execute  — approved plans only
 *   GET  /api/agent/plan     — plan list (recover pending work on load)
 *
 * Keeping the review model here means the approval gate's rules — which
 * actions a plan status allows, how a step's exact PayPal call and its
 * trigger are presented — are unit-tested without a browser, and the UI
 * can never offer an action the server would refuse.
 */

import { stepAmounts, type StepAmount } from "../agent/edit";
import type { ActionPlan, ActionStep, ActionType, CurrencyCode } from "../types";

/* ------------------------------------------------------------------ */
/* Example briefs (fictional demo data only)                           */
/* ------------------------------------------------------------------ */

export interface ExampleBrief {
  label: string;
  brief: string;
}

export const EXAMPLE_BRIEFS: ExampleBrief[] = [
  {
    label: "Invoice + gated payout (demo spine)",
    brief: "Invoice Ana $450 for brand work, due Friday. When it lands, pay $200 to my contractor Marco.",
  },
  {
    label: "Sell something",
    brief: "Sell a logo pack for $75",
  },
  {
    label: "Payment reminder",
    brief: "Remind Marco about his overdue invoice",
  },
];

/* ------------------------------------------------------------------ */
/* Brief validation                                                    */
/* ------------------------------------------------------------------ */

export const MAX_BRIEF_LENGTH = 500;

export type BriefValidation = { ok: true; brief: string } | { ok: false; error: string };

export function validateBrief(input: string): BriefValidation {
  const brief = input.trim();
  if (brief.length === 0) {
    return { ok: false, error: "Write a brief first — e.g. “Invoice Ana $450 for logo work, due Friday.”" };
  }
  if (brief.length > MAX_BRIEF_LENGTH) {
    return { ok: false, error: `Brief is too long (${brief.length}/${MAX_BRIEF_LENGTH} characters). Keep it to the money actions.` };
  }
  return { ok: true, brief };
}

/* ------------------------------------------------------------------ */
/* Approval-gate actions                                               */
/* ------------------------------------------------------------------ */

export interface PlanActions {
  canApprove: boolean;
  canReject: boolean;
  canExecute: boolean;
  /** Amend amounts (POST /api/agent/edit) — pending plans only. */
  canEdit: boolean;
}

/**
 * Mirrors the server-side gate exactly:
 * - approve / reject are only legal from `pending_approval`
 *   (LedgerStore.approvePlan / rejectPlan throw otherwise);
 * - execute is only legal from `approved` (the executor refuses
 *   every other status, including `awaiting_trigger` — gated steps
 *   resume via webhooks / sync, never via a second execute click);
 * - amending amounts is only legal from `pending_approval`
 *   (editPlanAmounts refuses every other status, so approval always
 *   covers exactly the steps the reviewer saw).
 */
export function availableActions(status: ActionPlan["status"]): PlanActions {
  return {
    canApprove: status === "pending_approval",
    canReject: status === "pending_approval",
    canExecute: status === "approved",
    canEdit: status === "pending_approval",
  };
}

/** Plans still waiting for a human decision, newest last (store order). */
export function pendingPlans(plans: ActionPlan[]): ActionPlan[] {
  return plans.filter((p) => p.status === "pending_approval");
}

/* ------------------------------------------------------------------ */
/* Plan review model                                                   */
/* ------------------------------------------------------------------ */

const TYPE_LABELS: Record<ActionType, string> = {
  create_invoice: "Create invoice",
  create_order: "Create checkout order",
  draft_payout: "Draft payout",
  send_reminder: "Send reminder",
};

export interface PlanReviewStep {
  index: number;
  type: ActionType;
  typeLabel: string;
  description: string;
  /** The exact PayPal call, shown before approval: "POST /v2/invoicing/invoices". */
  callLabel: string;
  /** True when the step waits for a trigger event instead of running now. */
  gated: boolean;
  /** Human trigger label, e.g. "Runs after INVOICING.INVOICE.PAID". Null when not gated. */
  triggerLabel: string | null;
  /**
   * The step's editable amounts (empty for reminders, which carry
   * none). `itemIndex` is null for a step's own amount, or the batch
   * line index for a payout batch.
   */
  editable: StepAmount[];
}

export interface PlanReview {
  planId: string;
  brief: string;
  status: ActionPlan["status"];
  steps: PlanReviewStep[];
  immediateCount: number;
  gatedCount: number;
  actions: PlanActions;
}

export function toReviewStep(step: ActionStep, index: number): PlanReviewStep {
  return {
    index,
    type: step.type,
    typeLabel: TYPE_LABELS[step.type],
    description: step.description,
    callLabel: `${step.paypalCall.method} ${step.paypalCall.path}`,
    gated: Boolean(step.trigger),
    triggerLabel: step.trigger ? `Runs after ${step.trigger.on}` : null,
    editable: stepAmounts(step),
  };
}

/* ------------------------------------------------------------------ */
/* Amount amendment (the plan-review Edit)                             */
/* ------------------------------------------------------------------ */

/** State key for one editable amount in the review form: "<step>:<line|null>". */
export function amountDraftKey(stepIndex: number, itemIndex: number | null): string {
  return `${stepIndex}:${itemIndex === null ? "-" : itemIndex}`;
}

export interface AmountDraft {
  amount: string;
  currency: CurrencyCode;
}

export interface StepAmountEditWire {
  stepIndex: number;
  amount?: string;
  currency?: CurrencyCode;
  items?: Array<{ index: number; amount: string; currency: CurrencyCode }>;
}

/**
 * Build the POST /api/agent/edit payload from the review form's raw
 * drafts: only amounts that actually differ from the plan's current
 * values are included (the server refuses a no-change edit, so the
 * form does not send one). Returns null when nothing changed.
 * Amounts are compared after the same normalisation the server
 * applies (commas stripped, two decimals), so "450" against a current
 * "450.00" is not a change.
 */
export function collectAmountEdits(review: PlanReview, drafts: Record<string, AmountDraft>): StepAmountEditWire[] | null {
  const edits: StepAmountEditWire[] = [];
  for (const step of review.steps) {
    const single: StepAmountEditWire = { stepIndex: step.index };
    const lines: NonNullable<StepAmountEditWire["items"]> = [];
    for (const entry of step.editable) {
      const draft = drafts[amountDraftKey(step.index, entry.itemIndex)];
      if (!draft) continue;
      const parsed = Number(draft.amount.replace(/,/g, ""));
      // An unparseable amount counts as changed so it still reaches
      // the server, which refuses it with a field-named error,
      // rather than vanishing silently in the form.
      const changed =
        draft.currency !== entry.amount.currency_code || !Number.isFinite(parsed) || parsed.toFixed(2) !== entry.amount.value;
      if (!changed) continue;
      if (entry.itemIndex === null) {
        single.amount = draft.amount;
        single.currency = draft.currency;
      } else {
        lines.push({ index: entry.itemIndex, amount: draft.amount, currency: draft.currency });
      }
    }
    if (lines.length > 0) single.items = lines;
    if (single.amount !== undefined || single.items !== undefined) edits.push(single);
  }
  return edits.length > 0 ? edits : null;
}

export function buildPlanReview(plan: ActionPlan): PlanReview {
  const steps = plan.steps.map(toReviewStep);
  const gatedCount = steps.filter((s) => s.gated).length;
  return {
    planId: plan.id,
    brief: plan.brief,
    status: plan.status,
    steps,
    immediateCount: steps.length - gatedCount,
    gatedCount,
    actions: availableActions(plan.status),
  };
}

/* ------------------------------------------------------------------ */
/* Execution outcome summary (shape returned by POST /api/agent/execute) */
/* ------------------------------------------------------------------ */

export interface ExecuteOutcomeWire {
  type: ActionType;
  outcome: "executed" | "deferred" | "failed";
  resultId?: string;
  error?: string;
}

export function summarizeOutcomes(outcomes: ExecuteOutcomeWire[]): string {
  if (outcomes.length === 0) return "Execution finished with no steps.";
  return outcomes
    .map((o) => {
      const label = TYPE_LABELS[o.type];
      if (o.outcome === "executed") return `${label}: done${o.resultId ? ` (${o.resultId})` : ""}`;
      if (o.outcome === "deferred") return `${label}: deferred until its trigger event arrives`;
      return `${label}: FAILED${o.error ? ` — ${o.error}` : ""}`;
    })
    .join(" · ");
}

/** One-line status explanation shown under the plan review. */
export function statusMessage(status: ActionPlan["status"]): string {
  switch (status) {
    case "pending_approval":
      return "Nothing has executed. Review the exact PayPal calls below, then approve or reject.";
    case "approved":
      return "Approved — execution is unlocked. Nothing has run yet.";
    case "rejected":
      return "Rejected — nothing executed, and this plan can no longer run.";
    case "executing":
      return "Executing…";
    case "awaiting_trigger":
      return "Partly executed — the remaining steps wait for their trigger event (webhook or sync).";
    case "completed":
      return "Completed — every step executed. See the audit grid for the full trace.";
    case "failed":
      return "A step failed — see the outcome summary and the audit grid for details.";
  }
}
