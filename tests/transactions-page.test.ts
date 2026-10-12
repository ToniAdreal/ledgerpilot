import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { buildTransactionRows } from "../src/lib/console/read-models";

const appDir = join(process.cwd(), "src", "app");
const read = (...parts: string[]) => readFileSync(join(appDir, ...parts), "utf8");

const ANA = { name: "Ana", email_address: "ana@example.com" };
const MARCO = { name: "Marco", email_address: "marco@example.com" };

// The standalone /transactions page (the Reconciliation —
// Transaction Search surface). The reconciliation grid already
// lived on the console home; this page is that ledger as its
// own route — the last console grid to get one. It must reuse
// the console's data path and view-models — a second, divergent
// ledger view would break the one-console story.
describe("Transactions page (/transactions — the reconciliation ledger's own page)", () => {
  it("the page carries typed metadata, the skip target, and routes back to the console + Judge Mode", () => {
    const src = read("transactions", "page.tsx");
    expect(src).toContain('import type { Metadata } from "next"');
    expect(src).toContain("LedgerPilot — Reconciliation");
    expect(src).toContain('id="main-content"');
    expect(src).toContain("tabIndex={-1}");
    expect(src).toContain('href="/"');
    expect(src).toContain('href="/judge"');
    expect(src).toContain("<TransactionsClient />");
  });

  it("the page states the read-only rule end to end", () => {
    const src = read("transactions", "page.tsx");
    expect(src).toMatch(/read-only/);
    expect(src).toMatch(/Transaction Search/);
    expect(src).toMatch(/signed amount/);
  });

  it("the client loads the same console transactions route the home grid uses — no new data path", () => {
    const src = read("transactions", "transactions-client.tsx");
    expect(src).toContain('fetch("/api/console/transactions")');
    expect(src.match(/fetch\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/method:\s*"POST"/);
  });

  it("the client renders the reconciliation grid with the console's columns", () => {
    const src = read("transactions", "transactions-client.tsx");
    for (const field of [
      "date",
      "id",
      "eventCode",
      "payerName",
      "subject",
      "status",
      "currency",
      "amountValue",
    ]) {
      expect(src).toContain(`field: "${field}"`);
    }
    expect(src).toContain("AgGridReact<TransactionRow>");
    expect(src).toContain("ModuleRegistry.registerModules([AllCommunityModule])");
  });

  it("the client reuses the console's state + export view-models instead of inventing its own", () => {
    const src = read("transactions", "transactions-client.tsx");
    expect(src).toContain("resolveGridOverlay");
    expect(src).toContain("buildOverlayTemplate");
    expect(src).toContain("gridCaption");
    expect(src).toContain("GRID_TITLES.transactions");
    expect(src).toContain('buildCsvExportParams("transactions")');
    expect(src).toContain("csvExportBlockReason");
    expect(src).toContain("exportDataAsCsv");
  });

  it("the client never calls a mutating endpoint", () => {
    const src = read("transactions", "transactions-client.tsx");
    expect(src).not.toContain("/api/agent/");
    expect(src).not.toContain("/api/paypal/");
    expect(src).not.toContain("/api/judge/");
  });

  it("the home page links to /transactions", () => {
    expect(read("page.tsx")).toContain('href="/transactions"');
  });

  it("the rows the page renders are the read model's signed ledger for a real invoice→payout loop", async () => {
    const client = new MockPayPalClient({ sampleDispute: false });
    const invoice = await client.createInvoice({
      recipient: ANA,
      items: [{ name: "Logo work", quantity: "1", unit_amount: { currency_code: "USD", value: "450.00" } }],
    });
    await client.sendInvoice(invoice.id);
    await client.recordInvoicePayment(invoice.id, { value: "450.00", currency_code: "USD" });
    await client.createPayout({
      items: [
        {
          recipient: MARCO,
          amount: { currency_code: "USD", value: "200.00" },
          note: "Contractor share",
        },
      ],
    });

    const rows = buildTransactionRows(await client.listTransactions());
    expect(rows.map((r) => r.amount)).toEqual(["-200.00", "450.00"]);
    expect(rows[0]!.amountValue).toBe(-200);
    expect(rows[1]!.amountValue).toBe(450);
    expect(rows.every((r) => r.currency === "USD")).toBe(true);
  });
});
