"use client";

/**
 * Payouts page client — the standalone payouts grid for /payouts
 * (CONCEPT.md §3.1: "payout batch builder: agent-drafted batch,
 * per-line validation, approval release" — the builder itself
 * lives in the console; this page is the payouts list). It
 * renders the same PayoutRow read model the console's Payouts
 * grid consumes, from the same route (GET /api/console/payouts)
 * — there is no second data path and no new API surface: this
 * component only gives the payout items a full-width,
 * addressable page of its own, one row per item with its batch
 * context flattened in.
 *
 * Presentation states come from the same pure view-models the
 * console uses (resolveGridOverlay / gridCaption / CSV export
 * gating in src/lib/console), so loading / error / empty /
 * filtered-empty read identically on both surfaces. AG Grid
 * Community only (no Enterprise features, no trial watermark).
 * Read-only as a list: the page fetches and exports; it never
 * calls a mutating endpoint — drafting batches and releasing
 * them through the approval gate stay in the Operations Console.
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
  buildCsvExportParams,
  buildOverlayTemplate,
  csvExportBlockReason,
  gridCaption,
  resolveGridOverlay,
  type ConsoleLoadStatus,
  type PayoutRow,
} from "../../lib/console";

ModuleRegistry.registerModules([AllCommunityModule]);

const gridTheme = themeQuartz.withParams({ fontFamily: "system-ui, sans-serif", fontSize: 13 });

function StatusPill(params: ICellRendererParams) {
  const value = String(params.value ?? "");
  return <span className={`pill pill-${value.toLowerCase().replace(/[^a-z]+/g, "-")}`}>{value}</span>;
}

export default function PayoutsClient() {
  const [rows, setRows] = useState<PayoutRow[]>([]);
  const [status, setStatus] = useState<ConsoleLoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [displayed, setDisplayed] = useState(0);
  const [filterActive, setFilterActive] = useState(false);
  const gridApi = useRef<GridApi | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/console/payouts");
      const json = (await res.json()) as { payouts?: PayoutRow[]; error?: string };
      if (!res.ok || !json.payouts) {
        throw new Error(json.error ?? `Failed to load payouts (HTTP ${res.status})`);
      }
      setRows(json.payouts);
      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load payouts");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stateInput = useMemo(
    () => ({
      grid: "payouts" as const,
      status,
      totalRows: rows.length,
      displayedRows: displayed,
      filterActive,
      errorMessage: error,
    }),
    [status, rows.length, displayed, filterActive, error],
  );

  /* Push the resolved overlay into the grid whenever the state
   * changes, mirroring the console: a failed refresh with rows on
   * screen keeps the rows (the error banner above carries it). */
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
    gridApi.current.exportDataAsCsv(buildCsvExportParams("payouts"));
  }, [exportReason]);

  const columns = useMemo<ColDef<PayoutRow>[]>(
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
          <h2>{GRID_TITLES.payouts}</h2>
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
            title={exportReason ?? "Download the visible payout rows as CSV"}
          >
            Export CSV
          </button>
        </div>
        <div className="grid-wrap">
          <AgGridReact<PayoutRow>
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
