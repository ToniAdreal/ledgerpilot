"use client";

/**
 * Operations console — KPI strip + AG Grid Invoices, Orders, Payouts,
 * and Agent Activity & Webhook audit grids, fed by /api/console/*
 * read models.
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
  buildOverlayTemplate,
  gridCaption,
  resolveConsoleBanner,
  resolveGridOverlay,
  resolveKpiDisplay,
  type ActivityRow,
  type ConsoleGridId,
  type ConsoleLoadStatus,
  type ConsoleSummary,
  type InvoiceRow,
  type OrderRow,
  type PayoutRow,
} from "../lib/console";
import { ASK_TARGETS, type AskResult, type AskTarget } from "../lib/ask";
import CommandBar from "./command-bar";
import AskBar from "./ask-bar";

ModuleRegistry.registerModules([AllCommunityModule]);

const gridTheme = themeQuartz.withParams({ fontFamily: "system-ui, sans-serif", fontSize: 13 });

function StatusPill(params: ICellRendererParams) {
  const value = String(params.value ?? "");
  return <span className={`pill pill-${value.toLowerCase().replace(/[^a-z]+/g, "-")}`}>{value}</span>;
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
};

export default function ConsoleClient() {
  const [summary, setSummary] = useState<ConsoleSummary | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [payouts, setPayouts] = useState<PayoutRow[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadStatus, setLoadStatus] = useState<ConsoleLoadStatus>("loading");
  const [gridDisplay, setGridDisplay] = useState<Record<ConsoleGridId, GridDisplay>>(EMPTY_DISPLAY);

  const totals: Record<ConsoleGridId, number> = {
    invoices: invoices.length,
    orders: orders.length,
    payouts: payouts.length,
    activity: activity.length,
  };

  const refresh = useCallback(async () => {
    setLoadStatus("loading");
    try {
      const [s, i, o, p, a] = await Promise.all([
        fetch("/api/console/summary").then((r) => r.json()),
        fetch("/api/console/invoices").then((r) => r.json()),
        fetch("/api/console/orders").then((r) => r.json()),
        fetch("/api/console/payouts").then((r) => r.json()),
        fetch("/api/console/activity").then((r) => r.json()),
      ]);
      setSummary(s.summary as ConsoleSummary);
      setInvoices(i.invoices as InvoiceRow[]);
      setOrders(o.orders as OrderRow[]);
      setPayouts(p.payouts as PayoutRow[]);
      setActivity(a.activity as ActivityRow[]);
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

  /* Data or load-status changes re-resolve every mounted grid. */
  useEffect(() => {
    for (const target of Object.keys(gridApis.current) as ConsoleGridId[]) {
      const api = gridApis.current[target];
      if (api) syncGrid(target, api);
    }
  }, [loadStatus, invoices, orders, payouts, activity, error, syncGrid]);

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
      { field: "invoiceNumber", headerName: "Invoice", width: 130, filter: "agTextColumnFilter" },
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

  const defaultColDef = useMemo<ColDef>(
    () => ({ sortable: true, filter: true, floatingFilter: true, resizable: true }),
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

  const sectionHead = (grid: ConsoleGridId) => (
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
    </div>
  );

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
      </div>

      <div className="grid-section">
        {sectionHead("invoices")}
        <div className="grid-wrap">
          <AgGridReact<InvoiceRow>
            theme={gridTheme}
            rowData={invoices}
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

      <div className="grid-section">
        {sectionHead("orders")}
        <div className="grid-wrap">
          <AgGridReact<OrderRow>
            theme={gridTheme}
            rowData={orders}
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

      <div className="grid-section">
        {sectionHead("payouts")}
        <div className="grid-wrap">
          <AgGridReact<PayoutRow>
            theme={gridTheme}
            rowData={payouts}
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
        {sectionHead("activity")}
        <div className="grid-wrap">
          <AgGridReact<ActivityRow>
            theme={gridTheme}
            rowData={activity}
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
