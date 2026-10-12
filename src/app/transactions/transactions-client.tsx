"use client";

/**
 * Transactions page client — the standalone reconciliation grid
 * for /transactions. It renders the same TransactionRow read
 * model the console's Reconciliation grid consumes, from the
 * same route (GET /api/console/transactions) — there is no
 * second data path and no new API surface: this component only
 * gives the signed transaction ledger a full-width, addressable
 * page of its own.
 *
 * Presentation states come from the same pure view-models the
 * console uses (resolveGridOverlay / gridCaption / CSV export
 * gating in src/lib/console), so loading / error / empty /
 * filtered-empty read identically on both surfaces. AG Grid
 * Community only (no Enterprise features, no trial watermark).
 * Read-only: the page fetches and exports; it never calls a
 * mutating endpoint — Transaction Search is read-only end to
 * end, and moving money stays in the Operations Console.
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
  type ModelUpdatedEvent,
} from "ag-grid-community";
import {
  GRID_TITLES,
  buildCsvExportParams,
  buildOverlayTemplate,
  csvExportBlockReason,
  gridCaption,
  resolveGridOverlay,
  type ConsoleLoadStatus,
  type TransactionRow,
} from "../../lib/console";

ModuleRegistry.registerModules([AllCommunityModule]);

const gridTheme = themeQuartz.withParams({ fontFamily: "system-ui, sans-serif", fontSize: 13 });

export default function TransactionsClient() {
  const [rows, setRows] = useState<TransactionRow[]>([]);
  const [status, setStatus] = useState<ConsoleLoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [displayed, setDisplayed] = useState(0);
  const [filterActive, setFilterActive] = useState(false);
  const gridApi = useRef<GridApi | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/console/transactions");
      const json = (await res.json()) as { transactions?: TransactionRow[]; error?: string };
      if (!res.ok || !json.transactions) {
        throw new Error(json.error ?? `Failed to load transactions (HTTP ${res.status})`);
      }
      setRows(json.transactions);
      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load transactions");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stateInput = useMemo(
    () => ({
      grid: "transactions" as const,
      status,
      totalRows: rows.length,
      displayedRows: displayed,
      filterActive,
      errorMessage: error,
    }),
    [status, rows.length, displayed, filterActive, error],
  );

  useEffect(() => {
    const api = gridApi.current;
    if (!api) return;
    const overlay = resolveGridOverlay(stateInput);
    api.setGridOption("overlayNoRowsTemplate", buildOverlayTemplate(overlay));
    if (overlay.kind === "none") api.hideOverlay();
    else api.showNoRowsOverlay();
  }, [stateInput]);

  const onGridReady = useCallback((event: GridReadyEvent) => {
    gridApi.current = event.api;
    setDisplayed(event.api.getDisplayedRowCount());
  }, []);

  const onModelUpdated = useCallback((event: ModelUpdatedEvent | FilterChangedEvent) => {
    setDisplayed(event.api.getDisplayedRowCount());
    setFilterActive(event.api.isAnyFilterPresent());
  }, []);

  const exportReason = csvExportBlockReason({ totalRows: rows.length, status });
  const onExport = useCallback(() => {
    if (exportReason || !gridApi.current) return;
    gridApi.current.exportDataAsCsv(buildCsvExportParams("transactions"));
  }, [exportReason]);

  const columns = useMemo<ColDef<TransactionRow>[]>(
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

  const getRowId = useCallback((params: { data: { id: string } }) => params.data.id, []);

  return (
    <section>
      {status === "error" && rows.length > 0 && (
        <p className="console-error" role="alert">
          Refresh failed: {error} — the rows below are the last loaded state. Press Refresh to
          try again.
        </p>
      )}
      <div className="grid-section">
        <div className="grid-section-head">
          <h2>{GRID_TITLES.transactions}</h2>
          <span className="grid-count">{rows.length}</span>
          <span className="grid-caption">{gridCaption(stateInput)}</span>
          <button type="button" className="command-btn" onClick={() => void load()} disabled={status === "loading"}>
            {status === "loading" ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            className="command-btn grid-export-btn"
            onClick={onExport}
            disabled={exportReason !== null}
            title={exportReason ?? "Download the visible transaction rows as CSV"}
          >
            Export CSV
          </button>
        </div>
        <div className="grid-wrap">
          <AgGridReact<TransactionRow>
            theme={gridTheme}
            rowData={rows}
            getRowId={getRowId}
            columnDefs={columns}
            defaultColDef={defaultColDef}
            onGridReady={onGridReady}
            onModelUpdated={onModelUpdated}
            onFilterChanged={onModelUpdated}
            overlayNoRowsTemplate={buildOverlayTemplate(resolveGridOverlay(stateInput))}
            pagination
            paginationPageSize={25}
            domLayout="autoHeight"
          />
        </div>
      </div>
    </section>
  );
}
