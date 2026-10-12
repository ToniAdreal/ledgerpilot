import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { LedgerStore } from "../src/lib/agent/store";
import { parseBrief } from "../src/lib/agent/parser";
import { executePlan } from "../src/lib/agent/executor";
import { buildOrderRows } from "../src/lib/console/read-models";

const appDir = join(process.cwd(), "src", "app");
const read = (...parts: string[]) => readFileSync(join(appDir, ...parts), "utf8");

// The standalone /checkout page (CONCEPT.md §3.1: "/checkout —
// 'Sell something' flow: create an Orders v2 checkout link, show
// buyer view"). The orders grid already lived on the console
// home; this page is that sell surface as its own route. It must
// reuse the console's data path and view-models — a second,
// divergent orders view would break the one-console story.
describe("Checkout page (/checkout — the sell surface's own page)", () => {
  it("the page carries typed metadata, the skip target, and routes back to the console + Judge Mode", () => {
    const src = read("checkout", "page.tsx");
    expect(src).toContain('import type { Metadata } from "next"');
    expect(src).toContain("LedgerPilot — Checkout");
    expect(src).toContain('id="main-content"');
    expect(src).toContain("tabIndex={-1}");
    expect(src).toContain('href="/"');
    expect(src).toContain('href="/judge"');
    expect(src).toContain("<CheckoutClient />");
  });

  it("the page states the read-only list rule and names the buyer view", () => {
    const src = read("checkout", "page.tsx");
    expect(src).toMatch(/Read-only/);
    expect(src).toMatch(/buyer/i);
    expect(src).toMatch(/checkout link/);
  });

  it("the client loads the same console orders route the home grid uses — no new data path", () => {
    const src = read("checkout", "checkout-client.tsx");
    expect(src).toContain('fetch("/api/console/orders")');
    // Exactly one fetch, and it is a plain GET of the read model.
    expect(src.match(/fetch\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/method:\s*"POST"/);
  });

  it("the client renders the orders grid with the console's columns", () => {
    const src = read("checkout", "checkout-client.tsx");
    for (const field of [
      "id",
      "description",
      "referenceId",
      "status",
      "currency",
      "amountValue",
      "captureId",
      "captureStatus",
      "checkoutLabel",
    ]) {
      expect(src).toContain(`field: "${field}"`);
    }
    expect(src).toContain("AgGridReact<OrderRow>");
    expect(src).toContain("ModuleRegistry.registerModules([AllCommunityModule])");
  });

  it("the client shows the buyer view via the checkout-link cell, without a capture action", () => {
    const src = read("checkout", "checkout-client.tsx");
    expect(src).toContain("cellRenderer: CheckoutLinkCell");
    expect(src).toContain("checkoutState");
    expect(src).toContain("checkoutUrl");
    // Capturing stays in the console: no capture button / handler here.
    expect(src).not.toContain("CaptureOrderCell");
    expect(src).not.toContain("onCaptureOrder");
  });

  it("the client reuses the console's state + export view-models instead of inventing its own", () => {
    const src = read("checkout", "checkout-client.tsx");
    expect(src).toContain("resolveGridOverlay");
    expect(src).toContain("buildOverlayTemplate");
    expect(src).toContain("gridCaption");
    expect(src).toContain("GRID_TITLES.orders");
    expect(src).toContain('buildCsvExportParams("orders")');
    expect(src).toContain("csvExportBlockReason");
    expect(src).toContain("exportDataAsCsv");
  });

  it("the client never calls a mutating endpoint", () => {
    const src = read("checkout", "checkout-client.tsx");
    expect(src).not.toContain("/api/agent/");
    expect(src).not.toContain("/api/paypal/");
    expect(src).not.toContain("/api/judge/");
  });

  it("the home page links to /checkout", () => {
    expect(read("page.tsx")).toContain('href="/checkout"');
  });

  it("the rows the page renders are the read model's rows for a real executed sell loop", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    const plan = parseBrief("Sell a logo pack for $75", { now: new Date("2026-10-10T00:00:00Z") });
    store.addPlan(plan);
    store.approvePlan(plan.id);
    const result = await executePlan(store, client, plan.id);
    expect(result.plan.status).toBe("completed");

    const orders = await client.listOrders();
    const rows = buildOrderRows(orders);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.description).toBe("logo pack");
    expect(row.status).toBe("CREATED");
    expect(row.currency).toBe("USD");
    expect(row.amount).toBe("75.00");
    expect(row.captured).toBe(false);
    expect(row.checkoutState).toBe("payable");
    expect(row.checkoutUrl).toContain("mock://");
    expect(row.checkoutIsMock).toBe(true);
    expect(row.checkoutLabel).toBe("Open mock checkout");
  });
});
