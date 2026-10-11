/**
 * Console sync view-model — the "Sync from PayPal" action.
 *
 * CONCEPT.md §3.1 gives local instances (and any deployment PayPal
 * cannot reach with webhooks) a polling reconciler at
 * `GET /api/paypal/sync` as the fallback that closes the loop. The
 * route existed since the core-loop milestone, but no console surface
 * ever called it: a seller whose invoice was paid on PayPal's hosted
 * page had no in-app way to reconcile that state or release a gated
 * payout without leaving the console for curl, or waiting for the
 * Judge Mode payment leg. This module is the pure, unit-tested half
 * of the console action: it validates the route's wire shape and
 * turns a sync result into the exact outcome copy the console shows.
 * The component half (console-client) only fetches and renders.
 *
 * Sync is safe by construction: the reconciler is idempotent and
 * never calls a mutating PayPal endpoint, so re-running it is a
 * no-op that this summary reports honestly as "nothing new".
 */

/* ------------------------------------------------------------------ */
/* Wire shape (GET /api/paypal/sync)                                   */
/* ------------------------------------------------------------------ */

export interface SyncWireResult {
  checked: { invoices: number; orders: number; payouts: number; emittedEvents: number };
  processedEventIds: string[];
  alreadyProcessedEventIds: string[];
  resumedPlans: string[];
  state: {
    invoices: Array<{ id: string; status: string }>;
    orders: Array<{ id: string; status: string }>;
    payouts: Array<{ id: string; status: string }>;
  };
}

export class SyncResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncResultError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new SyncResultError(`Sync response field 'checked.${field}' must be a non-negative number`);
  }
  return value;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new SyncResultError(`Sync response field '${field}' must be an array of strings`);
  }
  return [...(value as string[])];
}

function stateList(value: unknown, field: string): Array<{ id: string; status: string }> {
  if (!Array.isArray(value)) {
    throw new SyncResultError(`Sync response field 'state.${field}' must be an array`);
  }
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.status !== "string") {
      throw new SyncResultError(`Sync response field 'state.${field}[${index}]' must carry string id + status`);
    }
    return { id: entry.id, status: entry.status };
  });
}

/**
 * Validate an unknown JSON payload as the sync route's wire shape.
 * The console never renders a half-valid result: a malformed payload
 * throws `SyncResultError` and the UI surfaces that message instead.
 */
export function parseSyncWireResult(data: unknown): SyncWireResult {
  if (!isRecord(data)) throw new SyncResultError("Sync response must be a JSON object");
  if (!isRecord(data.checked)) throw new SyncResultError("Sync response field 'checked' must be an object");
  if (!isRecord(data.state)) throw new SyncResultError("Sync response field 'state' must be an object");
  return {
    checked: {
      invoices: countField(data.checked, "invoices"),
      orders: countField(data.checked, "orders"),
      payouts: countField(data.checked, "payouts"),
      emittedEvents: countField(data.checked, "emittedEvents"),
    },
    processedEventIds: stringList(data.processedEventIds, "processedEventIds"),
    alreadyProcessedEventIds: stringList(data.alreadyProcessedEventIds, "alreadyProcessedEventIds"),
    resumedPlans: stringList(data.resumedPlans, "resumedPlans"),
    state: {
      invoices: stateList(data.state.invoices, "invoices"),
      orders: stateList(data.state.orders, "orders"),
      payouts: stateList(data.state.payouts, "payouts"),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Outcome summary                                                     */
/* ------------------------------------------------------------------ */

export interface SyncSummary {
  headline: string;
  detail: string;
  newlyProcessedCount: number;
  alreadyProcessedCount: number;
  resumedPlanIds: string[];
  /** True when this sync changed anything (new events or resumed plans). */
  hadWork: boolean;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * The outcome copy for one sync run. A resumed plan is the headline
 * (it is money moving); newly processed events with no resumption
 * come next; a fully idempotent re-run says so plainly instead of
 * dressing a no-op up as work.
 */
export function summarizeSyncResult(result: SyncWireResult): SyncSummary {
  const newlyProcessedCount = result.processedEventIds.length;
  const alreadyProcessedCount = result.alreadyProcessedEventIds.length;
  const resumedPlanIds = [...result.resumedPlans];

  let headline: string;
  if (resumedPlanIds.length > 0) {
    headline = `Sync resumed ${plural(resumedPlanIds.length, "plan")}: ${resumedPlanIds.join(", ")}`;
  } else if (newlyProcessedCount > 0) {
    headline = `Sync processed ${plural(newlyProcessedCount, "new event")}`;
  } else {
    headline = "Sync complete — nothing new to reconcile";
  }

  const { invoices, orders, payouts, emittedEvents } = result.checked;
  const detail =
    `Checked ${plural(invoices, "invoice")}, ${plural(orders, "order")}, ` +
    `${plural(payouts, "payout batch", "payout batches")} and ${plural(emittedEvents, "emitted event")}. ` +
    `${newlyProcessedCount} newly processed, ${alreadyProcessedCount} already processed.`;

  return {
    headline,
    detail,
    newlyProcessedCount,
    alreadyProcessedCount,
    resumedPlanIds,
    hadWork: newlyProcessedCount > 0 || resumedPlanIds.length > 0,
  };
}

/**
 * A sync may run whenever the console is not already syncing; it is
 * deliberately allowed while a background refresh is loading (the
 * reconciler's result is what the refresh then renders). Returns the
 * block reason, or null when the action may run.
 */
export function syncBlockReason(input: { syncing: boolean }): string | null {
  if (input.syncing) return "Sync already in progress";
  return null;
}
