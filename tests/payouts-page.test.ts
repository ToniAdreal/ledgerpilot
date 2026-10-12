import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { LedgerStore } from "../src/lib/agent/store";
import { parseBrief } from "../src/lib/agent/parser";
import { executePlan } from "../src/lib/agent/executor";
import { buildPayoutRows } from "../src/lib/console/read-models";

const appDir = join(process.cwd(), "src", "app");
const read = (...parts: string[]) => readFileSync(join(appDir, ...parts), "utf8");

// The standalone /payouts page (CONCEPT.md §3.1: "/payouts —
// payout batch builder: agent-drafted batch, per-line
// validation, approval release"). The payouts grid and the
// batch builder already lived on the console home; this page
// is the payouts list as its own route. It must reuse the
// console's data path and view-models — a second, divergent
// payouts view would break the one-console story.
describe("Payouts page (/payouts — the payouts list's own page)", () => {
  it("the page carries typed metadata, the skip target, and routes back to the console + Judge Mode", () => {
    const src = read("payouts", "page.tsx");
    expect(src).toContain('import type { Metadata } from "next"');
    expect(src).toContain("LedgerPilot — Payouts");
    expect(src).toContain('id="main-content"');
    expect(src).toContain("tabIndex={-1}");
    expect(src).toContain('href="/"');
    expect(src).toContain('href="/judge"');
    expect(src).toContain("<PayoutsClient />");
  });

  it("the page states the read-only list rule and names the batch builder", () => {
    const src = read("payouts", "page.tsx");
    expect(src).toMatch(/Read-only/);
    expect(src).toMatch(/batch builder/);
    expect(src).toMatch(/approval gate/);
  });

  it("the client loads the same console payouts route the home grid uses — no new data path", () => {
    const src = read("payouts", "payouts-client.tsx");
    expect(src).toContain('fetch("/api/console/payouts")');
    // Exactly one fetch, and it is a plain GET of the read model.
    expect(src.match(/fetch\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/method:\s*"POST"/);
  });

  it("the client renders the payouts grid with the console's columns", () => {
    const src = read("payouts", "payouts-client.tsx");
    for (const field of [
      "timeCreated",
      "recipientName",
      "recipientEmail",
      "status",
      "currency",
      "amountValue",
      "note",
      "batchId",
    ]) {
      expect(src).toContain(`field: "${field}"`);
    }
    expect(src).toContain("AgGridReact<PayoutRow>");
    expect(src).toContain("ModuleRegistry.registerModules([AllCommunityModule])");
  });

  it("the client carries no batch-builder form or release action over", () => {
    const src = read("payouts", "payouts-client.tsx");
    // Drafting batches and releasing payouts stay in the console:
    // no batch form, no approve/execute handler here.
    expect(src).not.toContain("BatchBuilder");
    expect(src).not.toContain("batch-builder");
    expect(src).not.toContain("/api/agent/approve");
    expect(src).not.toContain("/api/agent/execute");
  });

  it("the client reuses the console's state + export view-models instead of inventing its own", () => {
    const src = read("payouts", "payouts-client.tsx");
    expect(src).toContain("resolveGridOverlay");
    expect(src).toContain("buildOverlayTemplate");
    expect(src).toContain("gridCaption");
    expect(src).toContain("GRID_TITLES.payouts");
    expect(src).toContain('buildCsvExportParams("payouts")');
    expect(src).toContain("csvExportBlockReason");
    expect(src).toContain("exportDataAsCsv");
  });

  it("the client never calls a mutating endpoint", () => {
    const src = read("payouts", "payouts-client.tsx");
    expect(src).not.toContain("/api/agent/");
    expect(src).not.toContain("/api/paypal/");
    expect(src).not.toContain("/api/judge/");
  });

  it("the home page links to /payouts", () => {
    expect(read("page.tsx")).toContain('href="/payouts"');
  });

  it("the rows the page renders are the read model's rows for a real executed payout loop", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    const plan = parseBrief("Pay $200 to Marco for hosting help", { now: new Date("2026-10-10T00:00:00Z") });
    store.addPlan(plan);
    store.approvePlan(plan.id);
    const result = await executePlan(store, client, plan.id);
    expect(result.plan.status).toBe("completed");

    const rows = buildPayoutRows(await client.listPayouts());
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.recipientName).toBe("Marco");
    expect(row.recipientEmail).toBe("marco@example.com");
    expect(row.status).toBe("SUCCESS");
    expect(row.currency).toBe("USD");
    expect(row.amount).toBe("200.00");
    expect(row.batchId).toMatch(/^BATCH-/);
    expect(row.batchStatus).toBe("SUCCESS");
  });
});
