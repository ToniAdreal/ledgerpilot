"use client";

/**
 * Checkout page client — the standalone orders grid for /checkout
 * (CONCEPT.md §3.1: "Sell something" flow — create an Orders v2
 * checkout link, show buyer view). It renders the same OrderRow
 * read model the console's Orders grid consumes, from the same
 * route (GET /api/console/orders) — there is no second data path
 * and no new API surface: this component only gives the checkout
 * orders a full-width, addressable page of its own, with the buyer
 * view column showing each payable order's checkout link.
 *
 * Presentation states come from the same pure view-models the
 * console uses (resolveGridOverlay / gridCaption / CSV export
 * gating in src/lib/console), so loading / error / empty /
 * filtered-empty read identically on both surfaces. AG Grid
 * Community only (no Enterprise features, no trial watermark).
 * Read-only as a list: the page fetches and exports; it never
 * calls a mutating endpoint — creating orders and capturing stay
 * in the Operations Console. The buyer view link is a plain
 * anchor to the order's checkout URL, not an API call.
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
  type OrderRow,
} from "../../lib/console";

ModuleRegistry.registerModules([AllCommunityModule]);

const gridTheme = themeQuartz.withParams({ fontFamily: "system-ui, sans-serif", fontSize: 13 });

function StatusPill(params: ICellRendererParams) {
  const value = String(params.value ?? "");
  return <span className={`pill pill-${value.toLowerCase().replace(/[^a-z]+/g, "-")}`}>{value}</span>;
}

/**
 * Buyer view for an order: the checkout link the buyer opens to
 * approve the order. A payable row links out (mock links are
 * labeled as mock, never disguised as a real PayPal page);
 * captured / voided / link-less rows show their honest state
 * instead of a dead link.
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

export default function CheckoutClient() {
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [status, setStatus] = useState<ConsoleLoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [displayed, setDisplayed] = useState(0);
  const [filterActive, setFilterActive] = useState(false);
  const gridApi = useRef<GridApi | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/console/orders");
      const json = (await res.json()) as { orders?: OrderRow[]; error?: string };
      if (!res.ok || !json.orders) {
        throw new Error(json.error ?? `Failed to load orders (HTTP ${res.status})`);
      }
      setRows(json.orders);
      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load orders");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stateInput = useMemo(
    () => ({
      grid: "orders" as const,
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
    gridApi.current.exportDataAsCsv(buildCsvExportParams("orders"));
  }, [exportReason]);

  const columns = useMemo<ColDef<OrderRow>[]>(
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
          <h2>{GRID_TITLES.orders}</h2>
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
            title={exportReason ?? "Download the visible order rows as CSV"}
          >
            Export CSV
          </button>
        </div>
        <div className="grid-wrap">
          <AgGridReact<OrderRow>
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
