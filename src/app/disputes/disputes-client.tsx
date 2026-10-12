"use client";

/**
 * Disputes page client — the standalone disputes grid for
 * /disputes. It renders the same DisputeRow read model the
 * console's Disputes grid consumes, from the same route
 * (GET /api/console/disputes) — there is no second data path
 * and no new API surface: this component only gives the
 * dispute rows a full-width, addressable page of their own.
 *
 * The Evidence draft is carried over from the console because
 * it belongs to this read-only surface: it loads the
 * deterministic, draft-only evidence summary
 * (GET /api/console/disputes/[id]/evidence, src/lib/disputes)
 * for seller review. It never submits anything to PayPal —
 * the Disputes integration is read-only end to end, so this
 * page's only fetches are those two GETs and nothing here
 * approves, executes, or moves money.
 *
 * Presentation states come from the same pure view-models the
 * console uses (resolveGridOverlay / gridCaption / CSV export
 * gating in src/lib/console), so loading / error / empty /
 * filtered-empty read identically on both surfaces. AG Grid
 * Community only (no Enterprise features, no trial watermark).
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
  type DisputeRow,
} from "../../lib/console";
import type { DisputeEvidenceSummary } from "../../lib/disputes";

ModuleRegistry.registerModules([AllCommunityModule]);

const gridTheme = themeQuartz.withParams({ fontFamily: "system-ui, sans-serif", fontSize: 13 });

function StatusPill(params: ICellRendererParams) {
  const value = String(params.value ?? "");
  return <span className={`pill pill-${value.toLowerCase().replace(/[^a-z]+/g, "-")}`}>{value}</span>;
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

export default function DisputesClient() {
  const [rows, setRows] = useState<DisputeRow[]>([]);
  const [status, setStatus] = useState<ConsoleLoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [displayed, setDisplayed] = useState(0);
  const [filterActive, setFilterActive] = useState(false);
  const [draftingDisputeId, setDraftingDisputeId] = useState<string | null>(null);
  const [evidenceSummary, setEvidenceSummary] = useState<DisputeEvidenceSummary | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const gridApi = useRef<GridApi | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/console/disputes");
      const json = (await res.json()) as { disputes?: DisputeRow[]; error?: string };
      if (!res.ok || !json.disputes) {
        throw new Error(json.error ?? `Failed to load disputes (HTTP ${res.status})`);
      }
      setRows(json.disputes);
      setStatus("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load disputes");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  const stateInput = useMemo(
    () => ({
      grid: "disputes" as const,
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
    gridApi.current.exportDataAsCsv(buildCsvExportParams("disputes"));
  }, [exportReason]);

  const columns = useMemo<ColDef<DisputeRow>[]>(
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
          <h2>{GRID_TITLES.disputes}</h2>
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
            title={exportReason ?? "Download the visible dispute rows as CSV"}
          >
            Export CSV
          </button>
        </div>
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
            rowData={rows}
            context={{ draftingDisputeId, onDraftEvidence: draftEvidence } satisfies EvidenceCellContext}
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
