"use client";

/**
 * Operations console — KPI strip + AG Grid Invoices, Orders, Payouts,
 * Agent Activity & Webhook audit, Disputes (read-only), and
 * Reconciliation / Transaction Search (read-only) grids, fed by
 * /api/console/* read models.
 *
 * AG Grid Community only (no Enterprise features, no trial watermark).
 * The Agent Command bar (brief → plan review → approve → execute)
 * sits above the KPI strip, and the Ask-the-grid bar below it applies
 * validated filter models from src/lib/ask via `api.setFilterModel`.
 * Judge Mode (src/lib/judge) seeds the demo scenario from /judge; the
 * console is where its spine plan is approved and executed.
 *
 * Loading / error / empty / filtered-empty presentation is resolved
 * by the pure view-model in src/lib/console/states.ts: this component
 * tracks load status + per-grid displayed counts, renders the console
 * banner and section captions from it, and pushes the resolved
 * overlay into each grid (`overlayNoRowsTemplate` + show/hide).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type FilterChangedEvent,
  type GridApi,
  type GridReadyEvent,
  type ICellRendererParams,
  type ModelUpdatedEvent,
} from "ag-grid-community";
import {
  GRID_TITLES,
  parseSyncWireResult,
  summarizeSyncResult,
  syncBlockReason,
  type SyncSummary,
  buildCsvExportParams,
  buildOverlayTemplate,
  csvExportBlockReason,
  findChangedRowIds,
  gridCaption,
  resolveConsoleBanner,
  resolveGridOverlay,
  resolveKpiDisplay,
  type ActivityRow,
  type ConsoleGridId,
  type ConsoleLoadStatus,
  type ConsoleSummary,
  type DisputeRow,
  type FlashRow,
  type InvoiceRow,
  type OrderRow,
  type PayoutRow,
  type TransactionRow,
} from "../lib/console";
import { ASK_TARGETS, type AskResult, type AskTarget } from "../lib/ask";
import type { DisputeEvidenceSummary } from "../lib/disputes";
import CommandBar from "./command-bar";
import AskBar from "./ask-bar";
import BatchBuilder from "./batch-builder";
import SellForm from "./sell-form";
import InvoiceForm from "./invoice-form";
import ReminderForm from "./reminder-form";

ModuleRegistry.registerModules([AllCommunityModule]);

const gridTheme = themeQuartz.withParams({ fontFamily: "system-ui, sans-serif", fontSize: 13 });

function StatusPill(params: ICellRendererParams) {
  const value = String(params.value ?? "");
  return <span className={`pill pill-${value.toLowerCase().replace(/[^a-z]+/g, "-")}`}>{value}</span>;
}

/** Invoice number as a link to the invoice detail page (/invoices/[id]). */
function InvoiceLink(params: ICellRendererParams<InvoiceRow>) {
  if (!params.data) return <>{String(params.value ?? "")}</>;
  return <a href={`/invoices/${params.data.id}`}>{String(params.value ?? "")}</a>;
}

interface CaptureCellContext {
  capturingOrderId: string | null;
  onCaptureOrder: (orderId: string) => void;
}

interface InvoicePaymentCellContext {
  payingInvoiceId: string | null;
  onRecordInvoicePayment: (invoiceId: string) => void;
}

/**
 * Record-payment for an open invoice (the Invoicing leg's payment
 * step, src/lib/invoice/record-payment): rendered only while the
 * invoice is open; the button records the full amount due — partial
 * amounts stay available on the API route. Paid / draft / cancelled
 * rows show a dash.
 */
function RecordInvoicePaymentCell(params: ICellRendererParams<InvoiceRow>) {
  const row = params.data;
  if (!row || (row.status !== "SENT" && row.status !== "PARTIALLY_PAID" && row.status !== "SCHEDULED")) {
    return <span>—</span>;
  }
  const ctx = params.context as InvoicePaymentCellContext;
  const busy = ctx.payingInvoiceId === row.id;
  return (
    <button
      type="button"
      className="command-btn capture-btn"
      disabled={busy || ctx.payingInvoiceId !== null}
      onClick={() => ctx.onRecordInvoicePayment(row.id)}
      title="Record a payment made outside PayPal for the full amount due"
    >
      {busy ? "Recording…" : "Record payment"}
    </button>
  );
}

/**
 * Buyer-side checkout completion for an uncaptured order (the Orders
 * leg's capture step, src/lib/checkout): rendered only while the order
 * can still be captured; captured / VOIDED rows show a dash.
 */
function CaptureOrderCell(params: ICellRendererParams<OrderRow>) {
  const row = params.data;
  if (!row || row.captured || row.status === "VOIDED") return <span>—</span>;
  const ctx = params.context as CaptureCellContext;
  const busy = ctx.capturingOrderId === row.id;
  return (
    <button
      type="button"
      className="command-btn capture-btn"
      disabled={busy || ctx.capturingOrderId !== null}
      onClick={() => ctx.onCaptureOrder(row.id)}
    >
      {busy ? "Capturing…" : "Capture"}
    </button>
  );
}

/**
 * Buyer view for an order (src/lib/checkout/checkout-link): the
 * checkout link the buyer opens to approve the order. A payable row
 * links out (mock links are labeled as mock, never disguised as a
 * real PayPal page); captured / voided / link-less rows show their
 * honest state instead of a dead link.
 */
function CheckoutLinkCell(params: ICellRendererParams<OrderRow>) {
  const row = params.data;
  if (!row) return <span>—</span>;
  if (row.checkoutState === "payable" && row.checkoutUrl) {
    return (
      <a className="checkout-link" href={row.checkoutUrl} target="_blank" rel="noreferrer">
        {row.checkoutLabel}
      </a>
    );
  }
  if (row.checkoutState === "voided") return <span>—</span>;
  return <span>{row.checkoutLabel}</span>;
}

interface EvidenceCellContext {
  draftingDisputeId: string | null;
  onDraftEvidence: (disputeId: string) => void;
}

/**
 * Draft-only dispute-evidence summary (src/lib/disputes): the button
 * loads the deterministic draft for seller review. It never submits
 * anything to PayPal — the Disputes integration is read-only.
 */
function EvidenceDraftCell(params: ICellRendererParams<DisputeRow>) {
  const row = params.data;
  if (!row) return <span>—</span>;
  const ctx = params.context as EvidenceCellContext;
  const busy = ctx.draftingDisputeId === row.id;
  return (
    <button
      type="button"
      className="command-btn capture-btn"
      disabled={busy || ctx.draftingDisputeId !== null}
      onClick={() => ctx.onDraftEvidence(row.id)}
    >
      {busy ? "Drafting…" : "Evidence draft"}
    </button>
  );
}

function formatTotals(totals: ConsoleSummary["outstanding"]): string {
  if (totals.length === 0) return "0.00";
  return totals.map((t) => `${t.currency_code} ${t.value}`).join(" · ");
}

interface GridDisplay {
  displayed: number;
  filterActive: boolean;
}

const EMPTY_DISPLAY: Record<ConsoleGridId, GridDisplay> = {
  invoices: { displayed: 0, filterActive: false },
  orders: { displayed: 0, filterActive: false },
  payouts: { displayed: 0, filterActive: false },
  activity: { displayed: 0, filterActive: false },
  disputes: { displayed: 0, filterActive: false },
  transactions: { displayed: 0, filterActive: false },
};

export default function ConsoleClient() {
  const [summary, setSummary] = useState<ConsoleSummary | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [payouts, setPayouts] = useState<PayoutRow[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [disputes, setDisputes] = useState<DisputeRow[]>([]);
  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [capturingOrderId, setCapturingOrderId] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [payingInvoiceId, setPayingInvoiceId] = useState<string | null>(null);
  const [invoicePaymentError, setInvoicePaymentError] = useState<string | null>(null);
  const [draftingDisputeId, setDraftingDisputeId] = useState<string | null>(null);
  const [evidenceSummary, setEvidenceSummary] = useState<DisputeEvidenceSummary | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [loadStatus, setLoadStatus] = useState<ConsoleLoadStatus>("loading");
  const [gridDisplay, setGridDisplay] = useState<Record<ConsoleGridId, GridDisplay>>(EMPTY_DISPLAY);

  const totals: Record<ConsoleGridId, number> = {
    invoices: invoices.length,
    orders: orders.length,
    payouts: payouts.length,
    activity: activity.length,
    disputes: disputes.length,
    transactions: transactions.length,
  };

  /* Change-flash bookkeeping (src/lib/console/grid-tools.ts): the
   * previous row snapshot per grid, and the ids whose watched fields
   * flipped on the latest refresh, waiting to be flashed once the
   * new rowData has rendered. */
  const prevRows = useRef<Record<ConsoleGridId, FlashRow[]>>({
    invoices: [], orders: [], payouts: [], activity: [], disputes: [], transactions: [],
  });
  const pendingFlash = useRef<Record<ConsoleGridId, string[]>>({
    invoices: [], orders: [], payouts: [], activity: [], disputes: [], transactions: [],
  });

  const refresh = useCallback(async () => {
    setLoadStatus("loading");
    try {
      const [s, i, o, p, a, d, t] = await Promise.all([
        fetch("/api/console/summary").then((r) => r.json()),
        fetch("/api/console/invoices").then((r) => r.json()),
        fetch("/api/console/orders").then((r) => r.json()),
        fetch("/api/console/payouts").then((r) => r.json()),
        fetch("/api/console/activity").then((r) => r.json()),
        fetch("/api/console/disputes").then((r) => r.json()),
        fetch("/api/console/transactions").then((r) => r.json()),
      ]);
      const nextRows: Record<ConsoleGridId, FlashRow[]> = {
        invoices: i.invoices as FlashRow[],
        orders: o.orders as FlashRow[],
        payouts: p.payouts as FlashRow[],
        activity: a.activity as FlashRow[],
        disputes: d.disputes as FlashRow[],
        transactions: t.transactions as FlashRow[],
      };
      for (const grid of Object.keys(nextRows) as ConsoleGridId[]) {
        const changed = findChangedRowIds(grid, prevRows.current[grid], nextRows[grid]);
        if (changed.length > 0) pendingFlash.current[grid] = changed;
        prevRows.current[grid] = nextRows[grid];
      }
      setSummary(s.summary as ConsoleSummary);
      setInvoices(i.invoices as InvoiceRow[]);
      setOrders(o.orders as OrderRow[]);
      setPayouts(p.payouts as PayoutRow[]);
      setActivity(a.activity as ActivityRow[]);
      setDisputes(d.disputes as DisputeRow[]);
      setTransactions(t.transactions as TransactionRow[]);
      setError(null);
      setLoadStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load console data");
      setLoadStatus("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* Sync from PayPal (src/lib/console/sync.ts): run the polling
   * reconciler — the webhook fallback — then refresh, so any state it
   * reconciled (and any gated plan it resumed) renders, with flipped
   * rows flashing via the usual change-flash path. The reconciler is
   * idempotent and never calls a mutating PayPal endpoint, so this is
   * always safe to run; the outcome summary says honestly whether it
   * found anything new. Errors surface in the sync notice, never
   * silently swallowed. */
  const runSync = useCallback(async () => {
    if (syncBlockReason({ syncing })) return;
    setSyncing(true);
    setSyncError(null);
    try {
      const res = await fetch("/api/paypal/sync");
      const data: unknown = await res.json();
      if (!res.ok) {
        const message =
          typeof data === "object" && data !== null && "error" in data
            ? String((data as { error: unknown }).error)
            : `Sync failed (${res.status})`;
        throw new Error(message);
      }
      setSyncSummary(summarizeSyncResult(parseSyncWireResult(data)));
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "Sync failed");
      setSyncSummary(null);
    } finally {
      setSyncing(false);
      void refresh();
    }
  }, [refresh, syncing]);

  /* Capture an uncaptured order (buyer-side checkout completion),
   * then refresh — the flipped COMPLETED row flashes via the usual
   * change-flash path. A refusal is shown under the Orders grid,
   * never silently swallowed. */
  const captureOrder = useCallback(
    async (orderId: string) => {
      setCapturingOrderId(orderId);
      setCaptureError(null);
      try {
        const res = await fetch("/api/paypal/orders/capture", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orderId }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(data.error ?? `Capture failed (${res.status})`);
      } catch (err) {
        setCaptureError(err instanceof Error ? err.message : "Capture failed");
      } finally {
        setCapturingOrderId(null);
        void refresh();
      }
    },
    [refresh],
  );

  /* Record a payment (full amount due) for an open invoice, then
   * refresh — the flipped PAID row flashes via the usual change-flash
   * path, and a trigger-gated payout bound to the invoice resumes
   * through the reconciler inside the route. A refusal is shown
   * under the Invoices grid, never silently swallowed. */
  const recordInvoicePayment = useCallback(
    async (invoiceId: string) => {
      setPayingInvoiceId(invoiceId);
      setInvoicePaymentError(null);
      try {
        const res = await fetch("/api/paypal/invoices/record-payment", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ invoiceId }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(data.error ?? `Recording the payment failed (${res.status})`);
      } catch (err) {
        setInvoicePaymentError(err instanceof Error ? err.message : "Recording the payment failed");
      } finally {
        setPayingInvoiceId(null);
        void refresh();
      }
    },
    [refresh],
  );

  /* Load a dispute's draft-only evidence summary for seller review.
   * Read-only GET — nothing is submitted to PayPal. Errors surface
   * under the Disputes grid, never silently swallowed. */
  const draftEvidence = useCallback(async (disputeId: string) => {
    setDraftingDisputeId(disputeId);
    setEvidenceError(null);
    try {
      const res = await fetch(`/api/console/disputes/${encodeURIComponent(disputeId)}/evidence`);
      const data = (await res.json()) as { summary?: DisputeEvidenceSummary; error?: string };
      if (!res.ok || !data.summary) throw new Error(data.error ?? `Evidence draft failed (${res.status})`);
      setEvidenceSummary(data.summary);
    } catch (err) {
      setEvidenceError(err instanceof Error ? err.message : "Evidence draft failed");
      setEvidenceSummary(null);
    } finally {
      setDraftingDisputeId(null);
    }
  }, []);

  /* Ask-the-grid: one GridApi per surface; a parsed query sets the
   * targeted grids' filter models and clears the rest, so the visible
   * state always matches the AskBar readout exactly. */
  const gridApis = useRef<Partial<Record<ConsoleGridId, GridApi>>>({});

  /* Latest load facts for the (stable) grid-event handlers below. */
  const loadFacts = useRef({ status: loadStatus, totals, error });
  loadFacts.current = { status: loadStatus, totals, error };

  /**
   * Push the view-model's verdict for one grid into that grid: the
   * resolved overlay template is shown when the grid has nothing to
   * display, and hidden when rows are on screen. A background refresh
   * (loading with rows already present) never covers live data.
   * Also mirrors displayed count / filter activity into React state
   * for the section captions.
   */
  const syncGrid = useCallback((target: ConsoleGridId, api: GridApi) => {
    const facts = loadFacts.current;
    const totalRows = facts.totals[target];
    const displayed = api.getDisplayedRowCount();
    const filterActive = api.isAnyFilterPresent();
    const overlay = resolveGridOverlay({
      grid: target,
      status: facts.status,
      totalRows,
      displayedRows: displayed,
      filterActive,
      errorMessage: facts.error,
    });
    if (overlay.kind === "none" || (overlay.kind === "loading" && totalRows > 0)) {
      api.hideOverlay();
    } else {
      api.setGridOption("overlayNoRowsTemplate", buildOverlayTemplate(overlay));
      api.showNoRowsOverlay();
    }
    setGridDisplay((prev) => {
      const current = prev[target];
      if (current.displayed === displayed && current.filterActive === filterActive) return prev;
      return { ...prev, [target]: { displayed, filterActive } };
    });
  }, []);

  const gridReady = useCallback(
    (target: ConsoleGridId) =>
      (event: GridReadyEvent): void => {
        gridApis.current[target] = event.api;
        syncGrid(target, event.api);
      },
    [syncGrid],
  );

  const gridModelUpdated = useCallback(
    (target: ConsoleGridId) =>
      (event: ModelUpdatedEvent | FilterChangedEvent): void => {
        syncGrid(target, event.api);
      },
    [syncGrid],
  );

  /* Data or load-status changes re-resolve every mounted grid, and
   * flash any rows whose state flipped on the latest refresh (the
   * row that just turned PAID is the demo's money shot). */
  useEffect(() => {
    for (const target of Object.keys(gridApis.current) as ConsoleGridId[]) {
      const api = gridApis.current[target];
      if (!api) continue;
      syncGrid(target, api);
      const ids = pendingFlash.current[target];
      if (ids.length > 0) {
        const nodes = ids
          .map((id) => api.getRowNode(id))
          .filter((n): n is NonNullable<typeof n> => !!n);
        if (nodes.length > 0) api.flashCells({ rowNodes: nodes });
        pendingFlash.current[target] = [];
      }
    }
  }, [loadStatus, invoices, orders, payouts, activity, disputes, transactions, error, syncGrid]);

  /* CSV export (Community feature): the pure view-model decides the
   * file name and whether an export may run; this only calls the API. */
  const exportCsv = useCallback(
    (grid: ConsoleGridId) => {
      const api = gridApis.current[grid];
      if (!api) return;
      if (csvExportBlockReason({ totalRows: loadFacts.current.totals[grid], status: loadFacts.current.status })) return;
      api.exportDataAsCsv(buildCsvExportParams(grid));
    },
    [],
  );

  const applyAsk = useCallback((result: AskResult) => {
    for (const target of ASK_TARGETS) {
      const api = gridApis.current[target];
      if (!api) continue;
      const model = result.models[target];
      api.setFilterModel(
        model ? (model as Parameters<GridApi["setFilterModel"]>[0]) : null,
      );
    }
  }, []);

  const clearAsk = useCallback(() => {
    for (const target of ASK_TARGETS) {
      gridApis.current[target]?.setFilterModel(null);
    }
  }, []);

  const invoiceColumns = useMemo<ColDef<InvoiceRow>[]>(
    () => [
      { field: "invoiceNumber", headerName: "Invoice", width: 130, filter: "agTextColumnFilter", cellRenderer: InvoiceLink },
      { field: "recipientName", headerName: "Recipient", width: 150, filter: "agTextColumnFilter" },
      { field: "recipientEmail", headerName: "Email", width: 200, filter: "agTextColumnFilter" },
      { field: "status", headerName: "Status", width: 150, cellRenderer: StatusPill, filter: "agTextColumnFilter" },
      { field: "currency", headerName: "Currency", width: 100, filter: "agTextColumnFilter" },
      {
        field: "amountValue",
        headerName: "Amount",
        width: 120,
        type: "rightAligned",
        filter: "agNumberColumnFilter",
        valueFormatter: (p) => (p.data ? `${p.data.currency} ${p.data.amount}` : ""),
      },
      {
        field: "dueValue",
        headerName: "Due",
        width: 120,
        type: "rightAligned",
        filter: "agNumberColumnFilter",
        valueFormatter: (p) => (p.data ? `${p.data.currency} ${p.data.dueAmount}` : ""),
      },
      { field: "dueDate", headerName: "Due date", width: 120, filter: "agDateColumnFilter" },
      {
        field: "overdue",
        headerName: "Overdue",
        width: 100,
        filter: false,
        valueFormatter: (p) => (p.value ? "Yes" : "—"),
        cellStyle: (p) => (p.value ? { color: "#b91c1c", fontWeight: 600 } : null),
      },
      { headerName: "Payment", width: 150, filter: false, sortable: false, cellRenderer: RecordInvoicePaymentCell },
    ],
    [],
  );

  const orderColumns = useMemo<ColDef<OrderRow>[]>(
    () => [
      { field: "id", headerName: "Order", width: 150, filter: "agTextColumnFilter" },
      { field: "description", headerName: "Description", flex: 1, minWidth: 220, filter: "agTextColumnFilter" },
      { field: "referenceId", headerName: "Reference", width: 150, filter: "agTextColumnFilter" },
      { field: "status", headerName: "Status", width: 140, cellRenderer: StatusPill, filter: "agTextColumnFilter" },
      { field: "currency", headerName: "Currency", width: 100, filter: "agTextColumnFilter" },
      {
        field: "amountValue",
        headerName: "Amount",
        width: 120,
        type: "rightAligned",
        filter: "agNumberColumnFilter",
        valueFormatter: (p) => (p.data ? `${p.data.currency} ${p.data.amount}` : ""),
      },
      { field: "captureId", headerName: "Capture", width: 150, filter: "agTextColumnFilter" },
      { field: "captureStatus", headerName: "Capture status", width: 140, cellRenderer: StatusPill, filter: "agTextColumnFilter" },
      { field: "checkoutLabel", headerName: "Buyer view", width: 170, filter: "agTextColumnFilter", cellRenderer: CheckoutLinkCell },
      { headerName: "Capture", width: 130, filter: false, sortable: false, cellRenderer: CaptureOrderCell },
    ],
    [],
  );

  const payoutColumns = useMemo<ColDef<PayoutRow>[]>(
    () => [
      {
        field: "timeCreated",
        headerName: "Time",
        width: 190,
        filter: "agDateColumnFilter",
        valueFormatter: (p) => (p.value ? new Date(String(p.value)).toLocaleString() : ""),
      },
      { field: "recipientName", headerName: "Recipient", width: 150, filter: "agTextColumnFilter" },
      { field: "recipientEmail", headerName: "Email", width: 200, filter: "agTextColumnFilter" },
      { field: "status", headerName: "Status", width: 130, cellRenderer: StatusPill, filter: "agTextColumnFilter" },
      { field: "currency", headerName: "Currency", width: 100, filter: "agTextColumnFilter" },
      {
        field: "amountValue",
        headerName: "Amount",
        width: 120,
        type: "rightAligned",
        filter: "agNumberColumnFilter",
        valueFormatter: (p) => (p.data ? `${p.data.currency} ${p.data.amount}` : ""),
      },
      { field: "note", headerName: "Note", flex: 1, minWidth: 180, filter: "agTextColumnFilter" },
      { field: "batchId", headerName: "Batch", width: 170, filter: "agTextColumnFilter" },
    ],
    [],
  );

  const activityColumns = useMemo<ColDef<ActivityRow>[]>(
    () => [
      {
        field: "createdAt",
        headerName: "Time",
        width: 190,
        filter: "agDateColumnFilter",
        valueFormatter: (p) => (p.value ? new Date(String(p.value)).toLocaleString() : ""),
      },
      { field: "kind", headerName: "Kind", width: 120, cellRenderer: StatusPill, filter: "agTextColumnFilter" },
      { field: "planId", headerName: "Plan", width: 120, filter: "agTextColumnFilter" },
      { field: "eventId", headerName: "Webhook event", width: 160, filter: "agTextColumnFilter" },
      { field: "summary", headerName: "Summary", flex: 1, minWidth: 320, filter: "agTextColumnFilter" },
    ],
    [],
  );

  const disputeColumns = useMemo<ColDef<DisputeRow>[]>(
    () => [
      { field: "id", headerName: "Dispute", width: 160, filter: "agTextColumnFilter" },
      { field: "buyerName", headerName: "Buyer", width: 140, filter: "agTextColumnFilter" },
      { field: "buyerEmail", headerName: "Buyer email", width: 190, filter: "agTextColumnFilter" },
      { field: "status", headerName: "Status", width: 210, cellRenderer: StatusPill, filter: "agTextColumnFilter" },
      { field: "stage", headerName: "Stage", width: 130, filter: "agTextColumnFilter" },
      { field: "reason", headerName: "Reason", flex: 1, minWidth: 240, filter: "agTextColumnFilter" },
      { field: "currency", headerName: "Currency", width: 100, filter: "agTextColumnFilter" },
      {
        field: "amountValue",
        headerName: "Amount",
        width: 120,
        type: "rightAligned",
        filter: "agNumberColumnFilter",
        valueFormatter: (p) => (p.data ? `${p.data.currency} ${p.data.amount}` : ""),
      },
      {
        field: "responseDueDate",
        headerName: "Response due",
        width: 170,
        filter: "agDateColumnFilter",
        valueFormatter: (p) => (p.value ? new Date(String(p.value)).toLocaleString() : "—"),
        cellStyle: (p) => (p.data?.responseOverdue ? { color: "#b91c1c", fontWeight: 600 } : null),
      },
      {
        field: "sample",
        headerName: "Sample",
        width: 100,
        filter: false,
        valueFormatter: (p) => (p.value ? "Sample" : "—"),
        cellStyle: (p) => (p.value ? { color: "#854d0e", fontWeight: 600 } : null),
      },
      { headerName: "Evidence", width: 150, filter: false, sortable: false, cellRenderer: EvidenceDraftCell },
    ],
    [],
  );

  const transactionColumns = useMemo<ColDef<TransactionRow>[]>(
    () => [
      {
        field: "date",
        headerName: "Date",
        width: 190,
        filter: "agDateColumnFilter",
        valueFormatter: (p) => (p.value ? new Date(String(p.value)).toLocaleString() : ""),
      },
      { field: "id", headerName: "Transaction", width: 170, filter: "agTextColumnFilter" },
      { field: "eventCode", headerName: "Event", width: 100, filter: "agTextColumnFilter" },
      { field: "payerName", headerName: "Payer", width: 140, filter: "agTextColumnFilter" },
      { field: "subject", headerName: "Subject", flex: 1, minWidth: 240, filter: "agTextColumnFilter" },
      { field: "status", headerName: "Status", width: 100, filter: "agTextColumnFilter" },
      { field: "currency", headerName: "Currency", width: 100, filter: "agTextColumnFilter" },
      {
        field: "amountValue",
        headerName: "Amount",
        width: 130,
        type: "rightAligned",
        filter: "agNumberColumnFilter",
        valueFormatter: (p) => (p.data ? `${p.data.currency} ${p.data.amount}` : ""),
        cellStyle: (p) => (p.value != null && p.value < 0 ? { color: "#b91c1c" } : null),
      },
    ],
    [],
  );

  const defaultColDef = useMemo<ColDef>(
    () => ({ sortable: true, filter: true, floatingFilter: true, resizable: true }),
    [],
  );

  /* Stable row ids (every read-model row carries `id`) — required so
   * flashCells / getRowNode can find the row that just flipped. */
  const getRowId = useCallback(
    (params: { data: { id: string } }) => params.data.id,
    [],
  );

  const banner = resolveConsoleBanner({ status: loadStatus, summary, errorMessage: error });
  const kpiTotals = (totalsValue: ConsoleSummary["outstanding"] | null): string =>
    resolveKpiDisplay(loadStatus, totalsValue ? formatTotals(totalsValue) : null);
  const kpiCount = (value: number | null): string => resolveKpiDisplay(loadStatus, value);

  const initialOverlay = (grid: ConsoleGridId): string =>
    buildOverlayTemplate(
      resolveGridOverlay({ grid, status: loadStatus, totalRows: totals[grid], errorMessage: error }),
    );

  const sectionHead = (grid: ConsoleGridId) => {
    const exportBlock = csvExportBlockReason({ totalRows: totals[grid], status: loadStatus });
    return (
      <div className="grid-section-head">
        <h2>{GRID_TITLES[grid]}</h2>
        <span className="grid-count">{totals[grid]}</span>
        <span className="grid-caption">
          {gridCaption({
            grid,
            status: loadStatus,
            totalRows: totals[grid],
            displayedRows: gridDisplay[grid].displayed,
            filterActive: gridDisplay[grid].filterActive,
            errorMessage: error,
          })}
        </span>
        <button
          type="button"
          className="command-btn grid-export-btn"
          disabled={exportBlock !== null}
          title={exportBlock ?? `Download ${GRID_TITLES[grid]} as CSV`}
          onClick={() => exportCsv(grid)}
        >
          Export CSV
        </button>
      </div>
    );
  };

  return (
    <section>
      <CommandBar onSettled={() => void refresh()} />
      <AskBar onApply={applyAsk} onClear={clearAsk} />

      {banner.kind !== "none" && (
        <div
          className={`console-banner console-banner-${banner.kind}`}
          role={banner.kind === "error" ? "alert" : "status"}
        >
          <strong>{banner.title}</strong>
          <span>{banner.message}</span>
          {banner.showJudgeLink && (
            <a className="command-btn judge-link-btn" href="/judge">
              Open Judge Mode
            </a>
          )}
          {banner.kind === "error" && (
            <button type="button" className="command-btn" onClick={() => void refresh()}>
              Retry
            </button>
          )}
        </div>
      )}

      <div className="kpi-strip" aria-busy={loadStatus === "loading"}>
        <div className="kpi">
          <span className="kpi-label">Outstanding</span>
          <span className="kpi-value">{kpiTotals(summary?.outstanding ?? null)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Collected to date</span>
          <span className="kpi-value">{kpiTotals(summary?.collected ?? null)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Pending approvals</span>
          <span className="kpi-value">{kpiCount(summary?.pendingApprovals ?? null)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Awaiting trigger</span>
          <span className="kpi-value">{kpiCount(summary?.awaitingTrigger ?? null)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Open disputes</span>
          <span className="kpi-value">{kpiCount(summary?.openDisputes ?? null)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Captured orders</span>
          <span className="kpi-value">{kpiTotals(summary?.capturedOrders ?? null)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Payouts sent</span>
          <span className="kpi-value">{kpiTotals(summary?.payoutsSent ?? null)}</span>
        </div>
        <button
          type="button"
          className="refresh-btn"
          disabled={loadStatus === "loading"}
          onClick={() => void refresh()}
        >
          {loadStatus === "loading" ? "Loading…" : "Refresh"}
        </button>
        <button
          type="button"
          className="refresh-btn sync-btn"
          disabled={syncBlockReason({ syncing }) !== null}
          title="Run the polling reconciler (webhook fallback): process any PayPal event or state the webhook listener has not seen, and resume gated plans"
          onClick={() => void runSync()}
        >
          {syncing ? "Syncing…" : "Sync from PayPal"}
        </button>
      </div>

      {(syncSummary || syncError) && (
        <div
          className={`console-banner sync-notice${syncError ? " console-banner-error" : ""}`}
          role={syncError ? "alert" : "status"}
        >
          {syncError ? (
            <>
              <strong>Sync failed</strong>
              <span>{syncError}</span>
            </>
          ) : syncSummary ? (
            <>
              <strong>{syncSummary.headline}</strong>
              <span>{syncSummary.detail}</span>
            </>
          ) : null}
        </div>
      )}

      <InvoiceForm onSettled={() => void refresh()} />

      <ReminderForm onSettled={() => void refresh()} />

      <div className="grid-section">
        {sectionHead("invoices")}
        {invoicePaymentError && (
          <p className="capture-error" role="alert">
            Recording the payment failed: {invoicePaymentError}
          </p>
        )}
        <div className="grid-wrap">
          <AgGridReact<InvoiceRow>
            theme={gridTheme}
            rowData={invoices}
            context={{ payingInvoiceId, onRecordInvoicePayment: recordInvoicePayment } satisfies InvoicePaymentCellContext}
            getRowId={getRowId}
            columnDefs={invoiceColumns}
            defaultColDef={defaultColDef}
            onGridReady={gridReady("invoices")}
            onModelUpdated={gridModelUpdated("invoices")}
            onFilterChanged={gridModelUpdated("invoices")}
            overlayNoRowsTemplate={initialOverlay("invoices")}
            pagination
            paginationPageSize={10}
            domLayout="autoHeight"
          />
        </div>
      </div>

      <SellForm onSettled={() => void refresh()} />

      <div className="grid-section">
        {sectionHead("orders")}
        {captureError && (
          <p className="capture-error" role="alert">
            Capture failed: {captureError}
          </p>
        )}
        <div className="grid-wrap">
          <AgGridReact<OrderRow>
            theme={gridTheme}
            rowData={orders}
            context={{ capturingOrderId, onCaptureOrder: captureOrder } satisfies CaptureCellContext}
            getRowId={getRowId}
            columnDefs={orderColumns}
            defaultColDef={defaultColDef}
            onGridReady={gridReady("orders")}
            onModelUpdated={gridModelUpdated("orders")}
            onFilterChanged={gridModelUpdated("orders")}
            overlayNoRowsTemplate={initialOverlay("orders")}
            pagination
            paginationPageSize={10}
            domLayout="autoHeight"
          />
        </div>
      </div>

      <BatchBuilder onSettled={() => void refresh()} />

      <div className="grid-section">
        {sectionHead("payouts")}
        <div className="grid-wrap">
          <AgGridReact<PayoutRow>
            theme={gridTheme}
            rowData={payouts}
            getRowId={getRowId}
            columnDefs={payoutColumns}
            defaultColDef={defaultColDef}
            onGridReady={gridReady("payouts")}
            onModelUpdated={gridModelUpdated("payouts")}
            onFilterChanged={gridModelUpdated("payouts")}
            overlayNoRowsTemplate={initialOverlay("payouts")}
            pagination
            paginationPageSize={10}
            domLayout="autoHeight"
          />
        </div>
      </div>

      <div className="grid-section">
        {sectionHead("disputes")}
        {evidenceError && (
          <p className="capture-error" role="alert">
            Evidence draft failed: {evidenceError}
          </p>
        )}
        {evidenceSummary && (
          <div className="evidence-panel">
            <div className="evidence-panel-head">
              <strong>{evidenceSummary.headline}</strong>
              <span className={`pill pill-${evidenceSummary.urgency.replace(/_/g, "-")}`}>{evidenceSummary.urgency}</span>
              <button
                type="button"
                className="command-btn"
                onClick={() => setEvidenceSummary(null)}
              >
                Close
              </button>
            </div>
            <p className="evidence-disclaimer">{evidenceSummary.disclaimer}</p>
            <h3>Evidence checklist</h3>
            <ul className="evidence-checklist">
              {evidenceSummary.checklist.map((item) => (
                <li key={item.label}>
                  <span aria-hidden="true">{item.present ? "✓" : "✗"}</span> <strong>{item.label}</strong> — {item.detail}
                </li>
              ))}
            </ul>
            {evidenceSummary.gaps.length > 0 && (
              <>
                <h3>Still to attach</h3>
                <ul>
                  {evidenceSummary.gaps.map((gap) => (
                    <li key={gap}>{gap}</li>
                  ))}
                </ul>
              </>
            )}
            <h3>Draft response (not submitted)</h3>
            <pre className="evidence-draft">{evidenceSummary.draftResponse}</pre>
          </div>
        )}
        <div className="grid-wrap">
          <AgGridReact<DisputeRow>
            theme={gridTheme}
            rowData={disputes}
            context={{ draftingDisputeId, onDraftEvidence: draftEvidence } satisfies EvidenceCellContext}
            getRowId={getRowId}
            columnDefs={disputeColumns}
            defaultColDef={defaultColDef}
            onGridReady={gridReady("disputes")}
            onModelUpdated={gridModelUpdated("disputes")}
            onFilterChanged={gridModelUpdated("disputes")}
            overlayNoRowsTemplate={initialOverlay("disputes")}
            pagination
            paginationPageSize={10}
            domLayout="autoHeight"
          />
        </div>
      </div>

      <div className="grid-section">
        {sectionHead("transactions")}
        <div className="grid-wrap">
          <AgGridReact<TransactionRow>
            theme={gridTheme}
            rowData={transactions}
            getRowId={getRowId}
            columnDefs={transactionColumns}
            defaultColDef={defaultColDef}
            onGridReady={gridReady("transactions")}
            onModelUpdated={gridModelUpdated("transactions")}
            onFilterChanged={gridModelUpdated("transactions")}
            overlayNoRowsTemplate={initialOverlay("transactions")}
            pagination
            paginationPageSize={10}
            domLayout="autoHeight"
          />
        </div>
      </div>

      <div className="grid-section">
        {sectionHead("activity")}
        <div className="grid-wrap">
          <AgGridReact<ActivityRow>
            theme={gridTheme}
            rowData={activity}
            getRowId={getRowId}
            columnDefs={activityColumns}
            defaultColDef={defaultColDef}
            onGridReady={gridReady("activity")}
            onModelUpdated={gridModelUpdated("activity")}
            onFilterChanged={gridModelUpdated("activity")}
            overlayNoRowsTemplate={initialOverlay("activity")}
            pagination
            paginationPageSize={10}
            domLayout="autoHeight"
          />
        </div>
      </div>
    </section>
  );
}
