/**
 * Console grid tools — CSV export + change-flash view-model.
 *
 * CONCEPT.md §3.3 lists, among the AG Grid Community features the
 * console uses properly: CSV export and "row highlighting on
 * webhook-driven state change (flash the row that just flipped to
 * PAID)". Both are Community-tier (verified: CSV export ships in
 * Community; row grouping — also mentioned in §3.3 — does NOT, it is
 * an Enterprise feature, so the Activity grid keeps its Plan column
 * + filter as the grouping substitute and no Enterprise module is
 * ever loaded; see CONCEPT.md §3.7's Community-only licensing rule).
 *
 * This module is the pure, unit-tested half: which file a grid
 * exports to, whether an export may run, and which rows changed
 * state between two refreshes. The component half (console-client)
 * only calls `api.exportDataAsCsv` / `api.flashCells` with what is
 * computed here.
 */

import type { ConsoleGridId } from "./states";

/* ------------------------------------------------------------------ */
/* CSV export                                                          */
/* ------------------------------------------------------------------ */

/** Per-grid export file stem — stable, filesystem-safe, dated. */
export function csvExportFileName(grid: ConsoleGridId, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  return `ledgerpilot-${grid}-${date}.csv`;
}

/**
 * The AG Grid CsvExportParams the console passes to
 * `exportDataAsCsv`. Only visible columns are exported (the grid's
 * value formatters supply the human-readable amounts), and the file
 * name comes from `csvExportFileName` so a test can pin it.
 */
export interface CsvExportParams {
  fileName: string;
  allColumns: false;
  onlySelected: false;
  suppressQuotes: false;
}

export function buildCsvExportParams(grid: ConsoleGridId, now: Date = new Date()): CsvExportParams {
  return {
    fileName: csvExportFileName(grid, now),
    allColumns: false,
    onlySelected: false,
    suppressQuotes: false,
  };
}

/**
 * An export may run only when the grid actually has rows and the
 * console is not mid-load: exporting an empty or half-refreshed grid
 * would hand the user a misleading file. Returns the reason when the
 * export is blocked, or null when it may run.
 */
export function csvExportBlockReason(input: {
  totalRows: number;
  status: "loading" | "ready" | "error";
}): string | null {
  if (input.status === "loading") return "Loading — wait for the refresh to finish";
  if (input.totalRows === 0) return "Nothing to export yet";
  return null;
}

/* ------------------------------------------------------------------ */
/* Change flash (webhook-driven state flips)                           */
/* ------------------------------------------------------------------ */

/** Minimal row shape the flash detector needs: a stable id + fields. */
export type FlashRow = { id: string } & Record<string, unknown>;

/**
 * Fields whose change means "this row's state flipped" per grid.
 * Append-only grids (activity, transactions) watch nothing: a new
 * audit row is not a state change, and flashing every new log line
 * would train the eye to ignore the flash. Disputes watch the
 * response-overdue flag as well as the status — a deadline passing
 * is exactly the kind of silent flip the console should surface.
 */
export const FLASH_WATCHED_FIELDS: Record<ConsoleGridId, readonly string[]> = {
  invoices: ["status", "dueAmount"],
  orders: ["status", "captureStatus"],
  payouts: ["status"],
  disputes: ["status", "responseOverdue"],
  transactions: [],
  activity: [],
};

/**
 * Ids of rows present in BOTH snapshots whose watched fields changed.
 * New rows never flash (they were not "flipped" — they arrived), and
 * removed rows cannot flash. Order follows the current snapshot.
 */
export function findChangedRowIds(
  grid: ConsoleGridId,
  previous: readonly FlashRow[],
  current: readonly FlashRow[],
): string[] {
  const fields = FLASH_WATCHED_FIELDS[grid];
  if (fields.length === 0 || previous.length === 0) return [];
  const before = new Map(previous.map((r) => [r.id, r]));
  const changed: string[] = [];
  for (const row of current) {
    const old = before.get(row.id);
    if (!old) continue;
    if (fields.some((f) => old[f] !== row[f])) changed.push(row.id);
  }
  return changed;
}
