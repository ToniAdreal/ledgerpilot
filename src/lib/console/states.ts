/**
 * Console state view-model — loading / error / empty / filtered-empty
 * presentation for the operations console.
 *
 * The console has more states than "has rows": a fresh runtime is
 * legitimately empty (nothing has moved yet), a failed fetch is an
 * error, a refresh-in-flight is loading, and an Ask-the-grid or column
 * filter can hide every row of a grid that does have data. Each state
 * gets its own honest copy here — pure and unit-tested — so the React
 * layer only renders what this module resolves.
 *
 * Grid ids reuse the Ask-the-grid target vocabulary so a grid is the
 * same identifier in the parser, the filter models, and these states.
 */

import type { AskTarget } from "../ask";
import type { ConsoleSummary } from "./read-models";

export type ConsoleGridId = AskTarget;
export type ConsoleLoadStatus = "loading" | "ready" | "error";

export const CONSOLE_GRID_IDS: ConsoleGridId[] = ["invoices", "orders", "payouts", "activity"];

export const GRID_TITLES: Record<ConsoleGridId, string> = {
  invoices: "Invoices",
  orders: "Orders / Checkout",
  payouts: "Payouts",
  activity: "Agent Activity & Webhook Audit",
};

/* ------------------------------------------------------------------ */
/* Per-grid overlays                                                   */
/* ------------------------------------------------------------------ */

export type GridOverlayKind = "loading" | "error" | "empty" | "filtered-empty" | "none";

export interface GridOverlay {
  kind: GridOverlayKind;
  title: string;
  hint: string;
}

const EMPTY_COPY: Record<ConsoleGridId, { title: string; hint: string }> = {
  invoices: {
    title: "No invoices yet",
    hint: "Draft an invoice brief in Agent Command above, or load the Judge Mode scenario to see invoices here.",
  },
  orders: {
    title: "No checkout orders yet",
    hint: "Use a sell brief in Agent Command (for example, “Sell a logo pack for $75”) to create the first order.",
  },
  payouts: {
    title: "No payouts yet",
    hint: "Payouts appear after an approved plan pays a contractor — gated payouts wait for their invoice to be paid first.",
  },
  activity: {
    title: "No activity yet",
    hint: "Every plan, approval, PayPal call, and verified webhook is written here. Draft a plan to start the audit trail.",
  },
};

export interface GridStateInput {
  grid: ConsoleGridId;
  status: ConsoleLoadStatus;
  /** Rows the grid holds in total (before any filter). */
  totalRows: number;
  /** Rows currently displayed (after filters); omit when unknown. */
  displayedRows?: number;
  /** Whether any filter (Ask model or column filter) is active. */
  filterActive?: boolean;
  errorMessage?: string | null;
}

/**
 * Resolve which overlay a grid shows. Precedence is deliberate:
 * loading beats everything (no stale verdicts mid-refresh); an error
 * only covers a grid that has no data to show (a failed refresh with
 * rows on screen keeps the rows — the console banner carries the
 * error instead); a loaded grid with data but zero displayed rows is
 * filtered-empty, never "empty", because the data exists.
 */
export function resolveGridOverlay(input: GridStateInput): GridOverlay {
  if (input.status === "loading") {
    return { kind: "loading", title: "Loading…", hint: "" };
  }
  if (input.status === "error" && input.totalRows === 0) {
    return {
      kind: "error",
      title: "Could not load this grid",
      hint: input.errorMessage
        ? `${input.errorMessage} — press Refresh to try again. No data was changed.`
        : "Press Refresh to try again. No data was changed.",
    };
  }
  if (input.totalRows === 0) {
    const copy = EMPTY_COPY[input.grid];
    return { kind: "empty", title: copy.title, hint: copy.hint };
  }
  const displayed = input.displayedRows ?? input.totalRows;
  if (displayed === 0) {
    return {
      kind: "filtered-empty",
      title: `No ${GRID_TITLES[input.grid].toLowerCase()} match the current filters`,
      hint: "Clear the filters above or ask a different Ask-the-grid question to see the rows again.",
    };
  }
  // A filter that still leaves rows visible needs no overlay, and an
  // inactive-filter grid with rows never does either.
  void input.filterActive;
  return { kind: "none", title: "", hint: "" };
}

/* ------------------------------------------------------------------ */
/* Overlay HTML templates (AG Grid renders these as HTML strings)      */
/* ------------------------------------------------------------------ */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * HTML for AG Grid's no-rows / loading overlay slots. Error text is
 * escaped: an overlay is rendered as raw HTML by the grid, so an
 * unescaped fetch error could inject markup into the console.
 */
export function buildOverlayTemplate(overlay: GridOverlay): string {
  if (overlay.kind === "none") return "";
  const hint = overlay.hint
    ? `<span class="grid-overlay-hint">${escapeHtml(overlay.hint)}</span>`
    : "";
  return `<div class="grid-overlay grid-overlay-${overlay.kind}"><span class="grid-overlay-title">${escapeHtml(overlay.title)}</span>${hint}</div>`;
}

/* ------------------------------------------------------------------ */
/* Console banner (one verdict for the whole console)                  */
/* ------------------------------------------------------------------ */

export type ConsoleBannerKind = "loading" | "error" | "fresh-start" | "none";

export interface ConsoleBanner {
  kind: ConsoleBannerKind;
  title: string;
  message: string;
  /** Fresh-start only: the banner links to the Judge Mode page. */
  showJudgeLink: boolean;
}

export function resolveConsoleBanner(input: {
  status: ConsoleLoadStatus;
  summary: ConsoleSummary | null;
  errorMessage?: string | null;
}): ConsoleBanner {
  if (input.status === "loading") {
    return {
      kind: "loading",
      title: "Loading console data…",
      message: "Fetching invoices, orders, payouts, and the audit trail.",
      showJudgeLink: false,
    };
  }
  if (input.status === "error") {
    return {
      kind: "error",
      title: "Console data failed to load",
      message: input.errorMessage
        ? `${input.errorMessage} — press Refresh to retry. Nothing was changed.`
        : "Press Refresh to retry. Nothing was changed.",
      showJudgeLink: false,
    };
  }
  const counts = input.summary?.counts;
  const total = counts ? counts.invoices + counts.orders + counts.payouts + counts.activity : 0;
  if (input.summary && total === 0) {
    return {
      kind: "fresh-start",
      title: "This console is empty — on purpose",
      message:
        "No money has moved yet, and nothing ever executes without your approval. Load the Judge Mode scenario for a one-click demo, or draft your first brief in Agent Command above.",
      showJudgeLink: true,
    };
  }
  return { kind: "none", title: "", message: "", showJudgeLink: false };
}

/* ------------------------------------------------------------------ */
/* KPI strip + section captions                                        */
/* ------------------------------------------------------------------ */

/** KPI value per load status: placeholder while loading, dash on error. */
export function resolveKpiDisplay(status: ConsoleLoadStatus, value: string | number | null): string {
  if (status === "loading") return "…";
  if (status === "error") return "—";
  return value === null ? "—" : String(value);
}

/** Section caption under a grid title, e.g. "3 invoices · newest first". */
export function gridCaption(input: GridStateInput & { displayedRows?: number }): string {
  const overlay = resolveGridOverlay(input);
  if (overlay.kind === "loading") return "Loading…";
  if (overlay.kind === "error") return "Failed to load — press Refresh to retry.";
  if (overlay.kind === "empty") return overlay.hint;
  if (overlay.kind === "filtered-empty") return `${input.totalRows} row${input.totalRows === 1 ? "" : "s"} on record — none match the current filters.`;
  const displayed = input.displayedRows ?? input.totalRows;
  if (input.filterActive && displayed !== input.totalRows) {
    return `Showing ${displayed} of ${input.totalRows} rows — filters active.`;
  }
  return `${input.totalRows} row${input.totalRows === 1 ? "" : "s"} · newest first.`;
}
