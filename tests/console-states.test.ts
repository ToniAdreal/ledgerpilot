import { describe, expect, it } from "vitest";
import {
  buildOverlayTemplate,
  escapeHtml,
  gridCaption,
  resolveConsoleBanner,
  resolveGridOverlay,
  resolveKpiDisplay,
  type ConsoleSummary,
} from "../src/lib/console";

const GRIDS = ["invoices", "orders", "payouts", "activity", "disputes", "transactions"] as const;

function summaryWith(counts: ConsoleSummary["counts"]): ConsoleSummary {
  return {
    outstanding: [],
    collected: [],
    capturedOrders: [],
    payoutsSent: [],
    pendingApprovals: 0,
    awaitingTrigger: 0,
    openDisputes: 0,
    counts,
  };
}

describe("grid overlays", () => {
  it("loading beats every other state", () => {
    for (const grid of GRIDS) {
      expect(resolveGridOverlay({ grid, status: "loading", totalRows: 0 }).kind).toBe("loading");
      expect(resolveGridOverlay({ grid, status: "loading", totalRows: 5, displayedRows: 5 }).kind).toBe("loading");
      expect(
        resolveGridOverlay({ grid, status: "loading", totalRows: 0, errorMessage: "boom" }).kind,
      ).toBe("loading");
    }
  });

  it("each grid gets its own empty copy, with a next action in the hint", () => {
    const titles = new Set<string>();
    for (const grid of GRIDS) {
      const overlay = resolveGridOverlay({ grid, status: "ready", totalRows: 0 });
      expect(overlay.kind).toBe("empty");
      expect(overlay.title).toMatch(/^No /);
      expect(overlay.hint.length).toBeGreaterThan(20);
      titles.add(overlay.title);
    }
    expect(titles.size).toBe(6); // no shared generic "no data" message
    expect(resolveGridOverlay({ grid: "invoices", status: "ready", totalRows: 0 }).hint).toContain("Judge Mode");
    expect(resolveGridOverlay({ grid: "activity", status: "ready", totalRows: 0 }).hint).toContain("audit trail");
  });

  it("error covers an empty grid but never hides rows already on screen", () => {
    const empty = resolveGridOverlay({ grid: "orders", status: "error", totalRows: 0, errorMessage: "fetch failed" });
    expect(empty.kind).toBe("error");
    expect(empty.hint).toContain("fetch failed");
    expect(empty.hint).toContain("No data was changed");

    const stale = resolveGridOverlay({ grid: "orders", status: "error", totalRows: 3, displayedRows: 3, errorMessage: "fetch failed" });
    expect(stale.kind).toBe("none"); // banner carries the error; rows stay visible

    const fallback = resolveGridOverlay({ grid: "orders", status: "error", totalRows: 0 });
    expect(fallback.hint).toContain("Press Refresh");
  });

  it("data hidden by filters is filtered-empty, not empty", () => {
    const overlay = resolveGridOverlay({
      grid: "invoices",
      status: "ready",
      totalRows: 4,
      displayedRows: 0,
      filterActive: true,
    });
    expect(overlay.kind).toBe("filtered-empty");
    expect(overlay.title).toContain("invoices");
    expect(overlay.title).toContain("match the current filters");
    // Even without the caller flagging it, zero displayed of a nonzero
    // total can only mean filtering — the verdict is the same.
    expect(
      resolveGridOverlay({ grid: "payouts", status: "ready", totalRows: 2, displayedRows: 0 }).kind,
    ).toBe("filtered-empty");
  });

  it("rows on screen mean no overlay, filtered or not", () => {
    expect(resolveGridOverlay({ grid: "invoices", status: "ready", totalRows: 3 }).kind).toBe("none");
    expect(
      resolveGridOverlay({ grid: "invoices", status: "ready", totalRows: 3, displayedRows: 1, filterActive: true }).kind,
    ).toBe("none");
  });
});

describe("overlay templates", () => {
  it("escapes HTML in titles and hints (overlays render as raw HTML)", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
    const overlay = resolveGridOverlay({
      grid: "invoices",
      status: "error",
      totalRows: 0,
      errorMessage: "<script>alert(1)</script>",
    });
    const html = buildOverlayTemplate(overlay);
    expect(html).toContain("grid-overlay-error");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(buildOverlayTemplate({ kind: "none", title: "", hint: "" })).toBe("");
    expect(buildOverlayTemplate(resolveGridOverlay({ grid: "orders", status: "ready", totalRows: 0 }))).toContain(
      "No checkout orders yet",
    );
  });
});

describe("console banner", () => {
  it("loading, then fresh-start only when every count is zero", () => {
    expect(resolveConsoleBanner({ status: "loading", summary: null }).kind).toBe("loading");

    const fresh = resolveConsoleBanner({
      status: "ready",
      summary: summaryWith({ invoices: 0, orders: 0, payouts: 0, plans: 0, activity: 0, disputes: 0, transactions: 0 }),
    });
    expect(fresh.kind).toBe("fresh-start");
    expect(fresh.showJudgeLink).toBe(true);
    expect(fresh.message).toContain("nothing ever executes without your approval");

    // Any single surface with data ends the fresh-start state.
    for (const counts of [
      { invoices: 1, orders: 0, payouts: 0, plans: 0, activity: 0, disputes: 0, transactions: 0 },
      { invoices: 0, orders: 0, payouts: 0, plans: 0, activity: 2, disputes: 0, transactions: 0 },
    ]) {
      expect(resolveConsoleBanner({ status: "ready", summary: summaryWith(counts) }).kind).toBe("none");
    }
  });

  it("error banner carries the message and the retry guidance", () => {
    const banner = resolveConsoleBanner({ status: "error", summary: null, errorMessage: "HTTP 500" });
    expect(banner.kind).toBe("error");
    expect(banner.message).toContain("HTTP 500");
    expect(banner.showJudgeLink).toBe(false);
  });
});

describe("KPI display + captions", () => {
  it("KPI shows a placeholder while loading and a dash on error", () => {
    expect(resolveKpiDisplay("loading", "USD 450.00")).toBe("…");
    expect(resolveKpiDisplay("error", "USD 450.00")).toBe("—");
    expect(resolveKpiDisplay("ready", "USD 450.00")).toBe("USD 450.00");
    expect(resolveKpiDisplay("ready", 3)).toBe("3");
    expect(resolveKpiDisplay("ready", null)).toBe("—");
  });

  it("captions describe counts, filtering, and failure honestly", () => {
    expect(gridCaption({ grid: "invoices", status: "ready", totalRows: 1 })).toBe("1 row · newest first.");
    expect(gridCaption({ grid: "invoices", status: "ready", totalRows: 5, displayedRows: 2, filterActive: true })).toContain(
      "Showing 2 of 5 rows",
    );
    expect(
      gridCaption({ grid: "invoices", status: "ready", totalRows: 5, displayedRows: 0, filterActive: true }),
    ).toContain("none match the current filters");
    expect(gridCaption({ grid: "orders", status: "error", totalRows: 0 })).toContain("Failed to load");
    expect(gridCaption({ grid: "orders", status: "loading", totalRows: 0 })).toBe("Loading…");
  });
});
