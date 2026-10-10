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
 * Judge Mode seeding lands in the remaining full-loop chunk.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
  type ICellRendererParams,
} from "ag-grid-community";
import type {
  ActivityRow,
  ConsoleSummary,
  InvoiceRow,
  OrderRow,
  PayoutRow,
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

export default function ConsoleClient() {
  const [summary, setSummary] = useState<ConsoleSummary | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [payouts, setPayouts] = useState<PayoutRow[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load console data");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* Ask-the-grid: one GridApi per surface; a parsed query sets the
   * targeted grids' filter models and clears the rest, so the visible
   * state always matches the AskBar readout exactly. */
  const gridApis = useRef<Partial<Record<AskTarget, GridApi>>>({});

  const gridReady = useCallback(
    (target: AskTarget) =>
      (event: GridReadyEvent): void => {
        gridApis.current[target] = event.api;
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

  return (
    <section>
      <CommandBar onSettled={() => void refresh()} />
      <AskBar onApply={applyAsk} onClear={clearAsk} />
      <div className="kpi-strip">
        <div className="kpi">
          <span className="kpi-label">Outstanding</span>
          <span className="kpi-value">{summary ? formatTotals(summary.outstanding) : "…"}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Collected to date</span>
          <span className="kpi-value">{summary ? formatTotals(summary.collected) : "…"}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Pending approvals</span>
          <span className="kpi-value">{summary ? summary.pendingApprovals : "…"}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Awaiting trigger</span>
          <span className="kpi-value">{summary ? summary.awaitingTrigger : "…"}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Open disputes</span>
          <span className="kpi-value">{summary ? summary.openDisputes : "…"}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Captured orders</span>
          <span className="kpi-value">{summary ? formatTotals(summary.capturedOrders) : "…"}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Payouts sent</span>
          <span className="kpi-value">{summary ? formatTotals(summary.payoutsSent) : "…"}</span>
        </div>
        <button type="button" className="refresh-btn" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {error && <p className="console-error">Console data failed to load: {error}</p>}

      <h2>Invoices</h2>
      <div className="grid-wrap">
        <AgGridReact<InvoiceRow>
          theme={gridTheme}
          rowData={invoices}
          columnDefs={invoiceColumns}
          defaultColDef={defaultColDef}
          onGridReady={gridReady("invoices")}
          pagination
          paginationPageSize={10}
          domLayout="autoHeight"
        />
      </div>

      <h2>Orders / Checkout</h2>
      <div className="grid-wrap">
        <AgGridReact<OrderRow>
          theme={gridTheme}
          rowData={orders}
          columnDefs={orderColumns}
          defaultColDef={defaultColDef}
          onGridReady={gridReady("orders")}
          pagination
          paginationPageSize={10}
          domLayout="autoHeight"
        />
      </div>

      <h2>Payouts</h2>
      <div className="grid-wrap">
        <AgGridReact<PayoutRow>
          theme={gridTheme}
          rowData={payouts}
          columnDefs={payoutColumns}
          defaultColDef={defaultColDef}
          onGridReady={gridReady("payouts")}
          pagination
          paginationPageSize={10}
          domLayout="autoHeight"
        />
      </div>

      <h2>Agent Activity &amp; Webhook Audit</h2>
      <div className="grid-wrap">
        <AgGridReact<ActivityRow>
          theme={gridTheme}
          rowData={activity}
          columnDefs={activityColumns}
          defaultColDef={defaultColDef}
          onGridReady={gridReady("activity")}
          pagination
          paginationPageSize={10}
          domLayout="autoHeight"
        />
      </div>
    </section>
  );
}
