/**
 * Console suggestions view-model — the "Suggest next actions" action.
 *
 * CONCEPT.md §3.1's data flow ends with the agent drafting the *next*
 * action as a new pending plan. The engine half lives in
 * `src/lib/agent/suggestions.ts` (overdue scan → one pending-approval
 * reminder plan per uncovered invoice, via `POST /api/agent/suggest`);
 * this module is the pure, unit-tested console half: it validates the
 * route's wire shape and turns a result into the exact outcome copy
 * the console shows. The component half (console-client) only fetches
 * and renders.
 *
 * Suggesting is safe by construction: the endpoint only drafts plans
 * behind the approval gate, so re-running it drafts nothing twice —
 * covered invoices come back as skips, which this summary reports
 * honestly instead of dressing a no-op up as work.
 */

/* ------------------------------------------------------------------ */
/* Wire shape (POST /api/agent/suggest)                                */
/* ------------------------------------------------------------------ */

export interface SuggestedReminderWire {
  planId: string;
  planStatus: string;
  invoiceId: string;
  invoiceNumber: string;
  recipientName: string;
  dueDate: string;
  dueAmount: { currency_code: string; value: string };
}

export interface SkippedSuggestionWire {
  invoiceId: string;
  invoiceNumber: string;
  reason: string;
  planId?: string;
  planStatus?: string;
}

export interface SuggestWireResult {
  referenceDate: string;
  overdueCount: number;
  drafted: SuggestedReminderWire[];
  skipped: SkippedSuggestionWire[];
}

export class SuggestResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuggestResultError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, field: string, where: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new SuggestResultError(`Suggest response field '${where}.${field}' must be a string`);
  }
  return value;
}

function parseDrafted(value: unknown): SuggestedReminderWire[] {
  if (!Array.isArray(value)) throw new SuggestResultError("Suggest response field 'drafted' must be an array");
  return value.map((entry, index) => {
    const where = `drafted[${index}]`;
    if (!isRecord(entry)) throw new SuggestResultError(`Suggest response field '${where}' must be an object`);
    if (!isRecord(entry.plan)) throw new SuggestResultError(`Suggest response field '${where}.plan' must be an object`);
    if (!isRecord(entry.dueAmount)) throw new SuggestResultError(`Suggest response field '${where}.dueAmount' must be an object`);
    return {
      planId: stringField(entry.plan, "id", `${where}.plan`),
      planStatus: stringField(entry.plan, "status", `${where}.plan`),
      invoiceId: stringField(entry, "invoiceId", where),
      invoiceNumber: stringField(entry, "invoiceNumber", where),
      recipientName: stringField(entry, "recipientName", where),
      dueDate: stringField(entry, "dueDate", where),
      dueAmount: {
        currency_code: stringField(entry.dueAmount, "currency_code", `${where}.dueAmount`),
        value: stringField(entry.dueAmount, "value", `${where}.dueAmount`),
      },
    };
  });
}

function parseSkipped(value: unknown): SkippedSuggestionWire[] {
  if (!Array.isArray(value)) throw new SuggestResultError("Suggest response field 'skipped' must be an array");
  return value.map((entry, index) => {
    const where = `skipped[${index}]`;
    if (!isRecord(entry)) throw new SuggestResultError(`Suggest response field '${where}' must be an object`);
    const parsed: SkippedSuggestionWire = {
      invoiceId: stringField(entry, "invoiceId", where),
      invoiceNumber: stringField(entry, "invoiceNumber", where),
      reason: stringField(entry, "reason", where),
    };
    if (entry.planId !== undefined) parsed.planId = stringField(entry, "planId", where);
    if (entry.planStatus !== undefined) parsed.planStatus = stringField(entry, "planStatus", where);
    return parsed;
  });
}

/**
 * Validate an unknown JSON payload as the suggest route's wire shape.
 * The console never renders a half-valid result: a malformed payload
 * throws `SuggestResultError` and the UI surfaces that message.
 */
export function parseSuggestWireResult(data: unknown): SuggestWireResult {
  if (!isRecord(data)) throw new SuggestResultError("Suggest response must be a JSON object");
  if (typeof data.overdueCount !== "number" || !Number.isFinite(data.overdueCount) || data.overdueCount < 0) {
    throw new SuggestResultError("Suggest response field 'overdueCount' must be a non-negative number");
  }
  return {
    referenceDate: stringField(data, "referenceDate", "response"),
    overdueCount: data.overdueCount,
    drafted: parseDrafted(data.drafted),
    skipped: parseSkipped(data.skipped),
  };
}

/* ------------------------------------------------------------------ */
/* Outcome summary                                                     */
/* ------------------------------------------------------------------ */

export interface SuggestSummary {
  headline: string;
  detail: string;
  draftedCount: number;
  skippedCount: number;
  overdueCount: number;
  /** True when this run drafted at least one new plan. */
  draftedAny: boolean;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const SKIP_REASON_COPY: Record<string, string> = {
  already_reminded: "reminder already sent",
  reminder_plan_exists: "a reminder plan already covers it",
};

/**
 * The outcome copy for one suggest run. Drafted plans are the
 * headline (they are the agent proposing work for approval); a run
 * that found overdue invoices but drafted nothing says why each was
 * skipped; a run with nothing overdue says exactly that.
 */
export function summarizeSuggestResult(result: SuggestWireResult): SuggestSummary {
  const draftedCount = result.drafted.length;
  const skippedCount = result.skipped.length;

  let headline: string;
  if (draftedCount > 0) {
    headline = `Agent drafted ${plural(draftedCount, "reminder plan")} for approval`;
  } else if (result.overdueCount > 0) {
    headline = "No new suggestions — every overdue invoice is already covered";
  } else {
    headline = "No overdue invoices — nothing to suggest";
  }

  const parts: string[] = [];
  for (const d of result.drafted) {
    parts.push(`${d.invoiceNumber} → ${d.recipientName} (${d.dueAmount.currency_code} ${d.dueAmount.value} due since ${d.dueDate}, plan ${d.planId})`);
  }
  for (const s of result.skipped) {
    const reason = SKIP_REASON_COPY[s.reason] ?? s.reason;
    parts.push(`${s.invoiceNumber} skipped — ${reason}${s.planId ? ` (${s.planId})` : ""}`);
  }
  const detail =
    parts.length > 0
      ? parts.join("; ")
      : `Checked at ${result.referenceDate}: no open invoice is past due. Drafted plans wait in the approval queue — nothing is sent without approval.`;

  return {
    headline,
    detail:
      draftedCount > 0
        ? `${detail} Drafted plans wait in the approval queue — nothing is sent without approval.`
        : detail,
    draftedCount,
    skippedCount,
    overdueCount: result.overdueCount,
    draftedAny: draftedCount > 0,
  };
}

/** The action is blocked only while a previous suggest run is in flight. */
export function suggestBlockReason(state: { suggesting: boolean }): string | null {
  return state.suggesting ? "A suggest run is already in flight" : null;
}
