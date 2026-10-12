import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { LedgerStore } from "../src/lib/agent/store";
import { parseBrief } from "../src/lib/agent/parser";
import { executePlan } from "../src/lib/agent/executor";
import { buildInvoiceRows } from "../src/lib/console/read-models";

const appDir = join(process.cwd(), "src", "app");
const read = (...parts: string[]) => readFileSync(join(appDir, ...parts), "utf8");

// The standalone /invoices list page (CONCEPT.md §3.1: "invoice
// list + detail (status timeline fed by webhooks)"). The detail
// half already lives at /invoices/[id]; this page is the list
// half as its own route. It must reuse the console's data path
// and view-models — a second, divergent invoice view would break
// the one-console story the page exists to extend.
describe("Invoices page (/invoices — the invoice list's own page)", () => {
  it("the page carries typed metadata, the skip target, and routes back to the console + Judge Mode", () => {
    const src = read("invoices", "page.tsx");
    expect(src).toContain('import type { Metadata } from "next"');
    expect(src).toContain("LedgerPilot — Invoices");
    expect(src).toContain('id="main-content"');
    expect(src).toContain("tabIndex={-1}");
    expect(src).toContain('href="/"');
    expect(src).toContain('href="/judge"');
    expect(src).toContain("<InvoicesClient />");
  });

  it("the page states the read-only list rule and points at the detail timeline", () => {
    const src = read("invoices", "page.tsx");
    expect(src).toMatch(/Read-only/);
    expect(src).toContain("/invoices/[id]");
    expect(src).toMatch(/status timeline/);
  });

  it("the client loads the same console invoices route the home grid uses — no new data path", () => {
    const src = read("invoices", "invoices-client.tsx");
    expect(src).toContain('fetch("/api/console/invoices")');
    // Exactly one fetch, and it is a plain GET of the read model.
    expect(src.match(/fetch\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/method:\s*"POST"/);
  });

  it("the client renders the invoice grid with the console's columns", () => {
    const src = read("invoices", "invoices-client.tsx");
    for (const field of [
      "invoiceNumber",
      "recipientName",
      "recipientEmail",
      "status",
      "currency",
      "amountValue",
      "dueValue",
      "dueDate",
      "overdue",
    ]) {
      expect(src).toContain(`field: "${field}"`);
    }
    expect(src).toContain("AgGridReact<InvoiceRow>");
    expect(src).toContain("ModuleRegistry.registerModules([AllCommunityModule])");
  });

  it("the client links each invoice number to its detail page", () => {
    const src = read("invoices", "invoices-client.tsx");
    expect(src).toContain("`/invoices/${params.data.id}`");
    expect(src).toContain("cellRenderer: InvoiceLink");
  });

  it("the client reuses the console's state + export view-models instead of inventing its own", () => {
    const src = read("invoices", "invoices-client.tsx");
    expect(src).toContain("resolveGridOverlay");
    expect(src).toContain("buildOverlayTemplate");
    expect(src).toContain("gridCaption");
    expect(src).toContain("GRID_TITLES.invoices");
    expect(src).toContain('buildCsvExportParams("invoices")');
    expect(src).toContain("csvExportBlockReason");
    expect(src).toContain("exportDataAsCsv");
  });

  it("the client never calls a mutating endpoint", () => {
    const src = read("invoices", "invoices-client.tsx");
    expect(src).not.toContain("/api/agent/");
    expect(src).not.toContain("/api/paypal/");
    expect(src).not.toContain("/api/judge/");
  });

  it("the home page links to /invoices", () => {
    expect(read("page.tsx")).toContain('href="/invoices"');
  });

  it("the rows the page renders are the read model's rows for a real executed loop", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    const plan = parseBrief(
      "Invoice Ana $450 for logo work, due Friday. When it lands, pay $200 to my contractor Marco.",
      { now: new Date("2026-10-10T00:00:00Z") },
    );
    store.addPlan(plan);
    store.approvePlan(plan.id);
    const result = await executePlan(store, client, plan.id);
    expect(result.plan.status).toBe("awaiting_trigger");

    const invoices = await client.listInvoices();
    const rows = buildInvoiceRows(invoices, "2026-10-10");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.recipientName).toBe("Ana");
    expect(row.status).toBe("SENT");
    expect(row.currency).toBe("USD");
    expect(row.amount).toBe("450.00");
    expect(row.dueAmount).toBe("450.00");
    expect(row.dueDate).toBe("2026-10-16");
    expect(row.overdue).toBe(false);
    expect(typeof row.id).toBe("string");
    expect(row.invoiceNumber).toBeTruthy();
  });
});
