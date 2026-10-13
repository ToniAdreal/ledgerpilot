/**
 * Plan amendment — the "Edit" in CONCEPT.md §3.1's plan review
 * ("Approve / Edit / Reject"), for amounts.
 *
 * A reviewer who spots a wrong amount in a pending plan should not
 * have to reject the plan and re-draft from scratch: this module
 * amends the amount (and currency) of a plan's money steps *before*
 * approval, and nothing else. Recipients, descriptions of work, due
 * dates, and triggers are not editable here — changing who gets paid
 * or what for is a new plan, not an amendment.
 *
 * The gate rules are the point:
 *  - Only a plan in `pending_approval` can be amended. Approval covers
 *    exactly the steps the reviewer saw, so an approved plan is
 *    immutable through this path (409) — as is every settled state.
 *  - Every new amount is validated through the drafts module's own
 *    `parseMoney` (positive, the same 100,000 hard cap, the USD/EUR/GBP
 *    whitelist) — the money rules live in exactly one place.
 *  - Each amended step's description is regenerated in the exact
 *    format its builder uses, so the review surface never shows a
 *    stale amount next to an edited payload.
 *  - The amendment is written to the audit log (old → new per step)
 *    before it is returned. The plan's `brief` is never rewritten:
 *    it is the historical record of what was originally asked; the
 *    amended step descriptions are what approval covers, and the
 *    audit record documents the change.
 *  - An amendment that changes nothing is refused (400) — a silent
 *    no-op would write a misleading audit entry.
 *  - Amending moves no money: it only rewrites a pending plan's
 *    steps, exactly like drafting does.
 */

import type { ActionPlan, ActionStep, Money, Party, PayoutItemInput } from "../types";
import { batchTotals, formatMoney, parseMoney } from "./drafts";
import type { LedgerStore } from "./store";

export class PlanEditError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PlanEditError";
    this.status = status;
  }
}

/** One line-level amount amendment inside a batch payout step. */
export interface PayoutLineEdit {
  index?: unknown;
  amount?: unknown;
  currency?: unknown;
}

/** One step-level amount amendment. `items` is only for batch payout steps. */
export interface StepAmountEdit {
  stepIndex?: unknown;
  amount?: unknown;
  currency?: unknown;
  items?: unknown;
}

export interface PlanAmountEdits {
  edits?: unknown;
}

/** The amount(s) a step currently carries, for review surfaces. */
export interface StepAmount {
  /** Batch line index, or null for the step's own single amount. */
  itemIndex: number | null;
  amount: Money;
}

/**
 * The editable amounts of a step: invoice → its first line item's unit
 * amount; order / single payout → the payload amount; batch payout →
 * one entry per line. Reminders carry no amount and return [].
 */
export function stepAmounts(step: ActionStep): StepAmount[] {
  const p = step.payload as Record<string, unknown>;
  if (step.type === "create_invoice") {
    const items = p.items as Array<{ unit_amount?: Money }> | undefined;
    const unit = items?.[0]?.unit_amount;
    return unit ? [{ itemIndex: null, amount: unit }] : [];
  }
  if (step.type === "create_order" || step.type === "draft_payout") {
    if (Array.isArray(p.items)) {
      return (p.items as PayoutItemInput[]).map((item, i) => ({ itemIndex: i, amount: item.amount }));
    }
    const amount = p.amount as Money | undefined;
    return amount ? [{ itemIndex: null, amount }] : [];
  }
  return [];
}

function gateSuffix(step: ActionStep): string {
  return step.trigger ? " — only after the invoice payment lands" : "";
}

function rebuildStep(step: ActionStep, payload: Record<string, unknown>): ActionStep {
  const p = payload as Record<string, unknown>;
  let description = step.description;
  if (step.type === "create_invoice") {
    const recipient = p.recipient as Party;
    const items = p.items as Array<{ name: string; unit_amount: Money }>;
    const first = items[0]!;
    const dueDate = p.dueDate as string | undefined;
    description = `Invoice ${recipient.name} ${formatMoney(first.unit_amount)} for ${first.name}${dueDate ? `, due ${dueDate}` : ""} — create the draft and send it`;
  } else if (step.type === "create_order") {
    description = `Create a checkout order: ${p.description as string} — ${formatMoney(p.amount as Money)}`;
  } else if (step.type === "draft_payout") {
    if (Array.isArray(p.items)) {
      const items = p.items as PayoutItemInput[];
      const lines = items.map((i) => `${formatMoney(i.amount)} to ${i.recipient.name}`).join(", ");
      const totals = batchTotals(items).map(formatMoney).join(" + ");
      description = `Pay out a batch of ${items.length}: ${lines} (total ${totals})${gateSuffix(step)}`;
    } else {
      const recipient = p.recipient as Party;
      description = `Pay out ${formatMoney(p.amount as Money)} to ${recipient.name}${gateSuffix(step)}`;
    }
  }
  return { ...step, description, payload };
}

function parseStepIndex(raw: unknown, stepCount: number, seen: Set<number>): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw >= stepCount) {
    throw new PlanEditError(400, `'stepIndex' must be an integer between 0 and ${stepCount - 1}`);
  }
  if (seen.has(raw)) {
    throw new PlanEditError(400, `step ${raw} is amended twice in one edit — combine the changes into one entry`);
  }
  seen.add(raw);
  return raw;
}

function moneyOrThrow(amount: unknown, currency: unknown, where: string): Money {
  try {
    return parseMoney(amount, currency);
  } catch (err) {
    throw new PlanEditError(400, `${where}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Amend the amounts of a pending plan's steps. Returns the amended
 * plan (still `pending_approval`). Throws PlanEditError with an HTTP
 * status: 404 unknown plan, 409 plan not pending approval, 400 any
 * validation failure (including an edit that changes nothing).
 */
export function editPlanAmounts(store: LedgerStore, planId: string, input: PlanAmountEdits): ActionPlan {
  const plan = store.getPlan(planId);
  if (!plan) {
    throw new PlanEditError(404, `Unknown plan: ${planId}`);
  }
  if (plan.status !== "pending_approval") {
    throw new PlanEditError(
      409,
      `Plan ${planId} cannot be amended from status ${plan.status} — only a plan still pending approval can be edited, so approval always covers exactly the steps the reviewer saw`,
    );
  }
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new PlanEditError(400, "'edits' must be a non-empty array of { stepIndex, amount, currency? } entries");
  }

  const steps = plan.steps.map((s) => ({ ...s, payload: structuredClone(s.payload) }));
  const seen = new Set<number>();
  const changes: string[] = [];
  const changeDetail: Array<Record<string, unknown>> = [];

  for (const rawEdit of input.edits as StepAmountEdit[]) {
    if (typeof rawEdit !== "object" || rawEdit === null || Array.isArray(rawEdit)) {
      throw new PlanEditError(400, "each edit must be an object with a stepIndex");
    }
    const stepIndex = parseStepIndex(rawEdit.stepIndex, steps.length, seen);
    const step = steps[stepIndex]!;
    const current = stepAmounts(step);
    if (current.length === 0) {
      throw new PlanEditError(400, `step ${stepIndex} (${step.type}) carries no amount to amend`);
    }
    const isBatch = current.length > 0 && current[0]!.itemIndex !== null;

    if (isBatch) {
      if (rawEdit.amount !== undefined || rawEdit.currency !== undefined) {
        throw new PlanEditError(400, `step ${stepIndex} is a payout batch — amend its lines via 'items', not a top-level amount`);
      }
      if (!Array.isArray(rawEdit.items) || rawEdit.items.length === 0) {
        throw new PlanEditError(400, `step ${stepIndex} is a payout batch — 'items' must be a non-empty array of { index, amount, currency? }`);
      }
      const seenLines = new Set<number>();
      const items = (step.payload as Record<string, unknown>).items as PayoutItemInput[];
      for (const rawLine of rawEdit.items as PayoutLineEdit[]) {
        if (typeof rawLine !== "object" || rawLine === null || Array.isArray(rawLine)) {
          throw new PlanEditError(400, `step ${stepIndex}: each line edit must be an object with an index`);
        }
        const lineIndex = rawLine.index;
        if (typeof lineIndex !== "number" || !Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= items.length) {
          throw new PlanEditError(400, `step ${stepIndex}: 'index' must be an integer between 0 and ${items.length - 1}`);
        }
        if (seenLines.has(lineIndex)) {
          throw new PlanEditError(400, `step ${stepIndex}: line ${lineIndex} is amended twice in one edit`);
        }
        seenLines.add(lineIndex);
        const money = moneyOrThrow(rawLine.amount, rawLine.currency, `step ${stepIndex} line ${lineIndex}`);
        const before = items[lineIndex]!.amount;
        if (before.currency_code === money.currency_code && before.value === money.value) continue;
        items[lineIndex] = { ...items[lineIndex]!, amount: money };
        changes.push(`step ${stepIndex + 1} line ${lineIndex + 1} amount ${formatMoney(before)} → ${formatMoney(money)}`);
        changeDetail.push({ stepIndex, itemIndex: lineIndex, from: before, to: money });
      }
      steps[stepIndex] = rebuildStep(step, step.payload as Record<string, unknown>);
      continue;
    }

    if (rawEdit.items !== undefined) {
      throw new PlanEditError(400, `step ${stepIndex} (${step.type}) is not a payout batch — amend its amount directly, not via 'items'`);
    }
    const money = moneyOrThrow(rawEdit.amount, rawEdit.currency, `step ${stepIndex}`);
    const before = current[0]!.amount;
    if (before.currency_code === money.currency_code && before.value === money.value) continue;
    const payload = step.payload as Record<string, unknown>;
    if (step.type === "create_invoice") {
      const items = payload.items as Array<{ unit_amount: Money }>;
      items[0] = { ...items[0]!, unit_amount: money };
    } else {
      payload.amount = money;
    }
    steps[stepIndex] = rebuildStep(step, payload);
    changes.push(`step ${stepIndex + 1} amount ${formatMoney(before)} → ${formatMoney(money)}`);
    changeDetail.push({ stepIndex, itemIndex: null, from: before, to: money });
  }

  if (changes.length === 0) {
    throw new PlanEditError(400, "the edit changes nothing — every amount already matches the plan");
  }

  const updated = store.replacePlanSteps(planId, steps);
  store.record({
    planId,
    kind: "system",
    summary: `Plan ${planId} amended before approval: ${changes.join("; ")}`,
    detail: { amended: true, changes: changeDetail },
  });
  return updated;
}
