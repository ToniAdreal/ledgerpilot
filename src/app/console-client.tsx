"use client";

/**
 * Operations console v1 — KPI strip + AG Grid Invoices grid + AG Grid
 * Agent Activity & Webhook audit grid, fed by /api/console/* read models.
 *
 * AG Grid Community only (no Enterprise features, no trial watermark).
 * Orders / Payouts grids and the Agent Command bar land in the
 * full-loop milestone; this surface already renders their data as KPIs.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type ICellRendererParams,
} from "ag-grid-community";
import type { ActivityRow, ConsoleSummary, InvoiceRow } from "../lib/console";

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
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, i, a] = await Promise.all([
        fetch("/api/console/summary").then((r) => r.json()),
        fetch("/api/console/invoices").then((r) => r.json()),
        fetch("/api/console/activity").then((r) => r.json()),
      ]);
      setSummary(s.summary as ConsoleSummary);
      setInvoices(i.invoices as InvoiceRow[]);
      setActivity(a.activity as ActivityRow[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load console data");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const invoiceColumns = useMemo<ColDef<InvoiceRow>[]>(
    () => [
      { field: "invoiceNumber", headerName: "Invoice", width: 130 },
      { field: "recipientName", headerName: "Recipient", width: 150 },
      { field: "recipientEmail", headerName: "Email", width: 200 },
      { field: "status", headerName: "Status", width: 150, cellRenderer: StatusPill },
      {
        field: "amountValue",
        headerName: "Amount",
        width: 120,
        type: "rightAligned",
        valueFormatter: (p) => (p.data ? `${p.data.currency} ${p.data.amount}` : ""),
      },
      {
        field: "dueValue",
        headerName: "Due",
        width: 120,
        type: "rightAligned",
        valueFormatter: (p) => (p.data ? `${p.data.currency} ${p.data.dueAmount}` : ""),
      },
      { field: "dueDate", headerName: "Due date", width: 120 },
      {
        field: "overdue",
        headerName: "Overdue",
        width: 100,
        valueFormatter: (p) => (p.value ? "Yes" : "—"),
        cellStyle: (p) => (p.value ? { color: "#b91c1c", fontWeight: 600 } : null),
      },
    ],
    [],
  );

  const activityColumns = useMemo<ColDef<ActivityRow>[]>(
    () => [
      {
        field: "createdAt",
        headerName: "Time",
        width: 190,
        valueFormatter: (p) => (p.value ? new Date(String(p.value)).toLocaleString() : ""),
      },
      { field: "kind", headerName: "Kind", width: 120, cellRenderer: StatusPill },
      { field: "planId", headerName: "Plan", width: 120 },
      { field: "eventId", headerName: "Webhook event", width: 160 },
      { field: "summary", headerName: "Summary", flex: 1, minWidth: 320 },
    ],
    [],
  );

  const defaultColDef = useMemo<ColDef>(
    () => ({ sortable: true, filter: true, floatingFilter: true, resizable: true }),
    [],
  );

  return (
    <section>
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
          pagination
          paginationPageSize={10}
          domLayout="autoHeight"
        />
      </div>
    </section>
  );
}
