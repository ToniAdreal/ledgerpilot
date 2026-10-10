import { describe, expect, it } from "vitest";
import {
  FLASH_WATCHED_FIELDS,
  buildCsvExportParams,
  csvExportBlockReason,
  csvExportFileName,
  findChangedRowIds,
  type FlashRow,
} from "../src/lib/console/grid-tools";
import { CONSOLE_GRID_IDS } from "../src/lib/console/states";

const row = (id: string, fields: Record<string, unknown> = {}): FlashRow => ({ id, ...fields });

describe("CSV export naming + params", () => {
  it("builds a dated, per-grid file name from the injected clock", () => {
    const now = new Date("2026-10-10T15:34:59Z");
    expect(csvExportFileName("invoices", now)).toBe("ledgerpilot-invoices-2026-10-10.csv");
    expect(csvExportFileName("activity", now)).toBe("ledgerpilot-activity-2026-10-10.csv");
    expect(csvExportFileName("transactions", now)).toBe("ledgerpilot-transactions-2026-10-10.csv");
  });

  it("export params carry the file name and visible-columns-only flags", () => {
    const params = buildCsvExportParams("payouts", new Date("2026-11-01T00:00:00Z"));
    expect(params).toEqual({
      fileName: "ledgerpilot-payouts-2026-11-01.csv",
      allColumns: false,
      onlySelected: false,
      suppressQuotes: false,
    });
  });
});

describe("CSV export gating", () => {
  it("blocks while loading and when the grid is empty; allows a loaded grid with rows", () => {
    expect(csvExportBlockReason({ totalRows: 3, status: "loading" })).toMatch(/Loading/);
    expect(csvExportBlockReason({ totalRows: 0, status: "ready" })).toMatch(/Nothing to export/);
    expect(csvExportBlockReason({ totalRows: 0, status: "error" })).toMatch(/Nothing to export/);
    expect(csvExportBlockReason({ totalRows: 3, status: "ready" })).toBeNull();
    // A failed refresh keeps live rows on screen — those rows may still be exported.
    expect(csvExportBlockReason({ totalRows: 3, status: "error" })).toBeNull();
  });
});

describe("change-flash detection", () => {
  it("flashes the invoice row that flipped SENT -> PAID (the demo money shot)", () => {
    const before = [row("INV-1", { status: "SENT", dueAmount: "450.00" }), row("INV-2", { status: "SENT", dueAmount: "80.00" })];
    const after = [row("INV-1", { status: "PAID", dueAmount: "0.00" }), row("INV-2", { status: "SENT", dueAmount: "80.00" })];
    expect(findChangedRowIds("invoices", before, after)).toEqual(["INV-1"]);
  });

  it("a partial payment flashes via the watched dueAmount even though the status also changed form", () => {
    const before = [row("INV-1", { status: "SENT", dueAmount: "300.00" })];
    const after = [row("INV-1", { status: "PARTIALLY_PAID", dueAmount: "200.00" })];
    expect(findChangedRowIds("invoices", before, after)).toEqual(["INV-1"]);
  });

  it("new rows never flash and removed rows cannot flash", () => {
    const before = [row("INV-1", { status: "SENT", dueAmount: "10.00" })];
    const after = [row("INV-2", { status: "SENT", dueAmount: "10.00" }), row("INV-1", { status: "SENT", dueAmount: "10.00" })];
    expect(findChangedRowIds("invoices", before, after)).toEqual([]);
    expect(findChangedRowIds("invoices", before, [])).toEqual([]);
    expect(findChangedRowIds("invoices", [], after)).toEqual([]);
  });

  it("unwatched field changes do not flash", () => {
    const before = [row("INV-1", { status: "SENT", dueAmount: "10.00", recipientName: "Ana" })];
    const after = [row("INV-1", { status: "SENT", dueAmount: "10.00", recipientName: "Ana R." })];
    expect(findChangedRowIds("invoices", before, after)).toEqual([]);
  });

  it("orders flash on capture, payouts on status, disputes on status or a deadline passing", () => {
    expect(
      findChangedRowIds(
        "orders",
        [row("O-1", { status: "CREATED", captureStatus: "" })],
        [row("O-1", { status: "COMPLETED", captureStatus: "COMPLETED" })],
      ),
    ).toEqual(["O-1"]);
    expect(
      findChangedRowIds("payouts", [row("P-1", { status: "PENDING" })], [row("P-1", { status: "SUCCESS" })]),
    ).toEqual(["P-1"]);
    expect(
      findChangedRowIds(
        "disputes",
        [row("D-1", { status: "WAITING_FOR_SELLER_RESPONSE", responseOverdue: false })],
        [row("D-1", { status: "WAITING_FOR_SELLER_RESPONSE", responseOverdue: true })],
      ),
    ).toEqual(["D-1"]);
  });

  it("append-only grids watch nothing, and every console grid has a watched-fields entry", () => {
    expect(FLASH_WATCHED_FIELDS.activity).toEqual([]);
    expect(FLASH_WATCHED_FIELDS.transactions).toEqual([]);
    const before = [row("A-1", { summary: "x" })];
    const after = [row("A-1", { summary: "y" }), row("A-2", { summary: "new" })];
    expect(findChangedRowIds("activity", before, after)).toEqual([]);
    for (const grid of CONSOLE_GRID_IDS) {
      expect(FLASH_WATCHED_FIELDS[grid]).toBeDefined();
    }
  });

  it("multiple flips are returned in current-snapshot order", () => {
    const before = [row("P-1", { status: "PENDING" }), row("P-2", { status: "PENDING" }), row("P-3", { status: "PENDING" })];
    const after = [row("P-3", { status: "SUCCESS" }), row("P-2", { status: "PENDING" }), row("P-1", { status: "FAILED" })];
    expect(findChangedRowIds("payouts", before, after)).toEqual(["P-3", "P-1"]);
  });
});
