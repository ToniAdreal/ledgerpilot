import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { LedgerStore } from "../src/lib/agent/store";
import { parseBrief } from "../src/lib/agent/parser";
import { executePlan } from "../src/lib/agent/executor";
import { buildActivityRows } from "../src/lib/console/read-models";

const appDir = join(process.cwd(), "src", "app");
const read = (...parts: string[]) => readFileSync(join(appDir, ...parts), "utf8");

// The standalone /activity page (CONCEPT.md §3.1): the audit trail's
// own addressable surface. It must reuse the console's data path and
// view-models — a second, divergent audit view would break the
// "one unbroken trace" story the page exists to tell.
describe("Activity page (/activity — the audit trail's own page)", () => {
  it("the page carries typed metadata, the skip target, and routes back to the console + Judge Mode", () => {
    const src = read("activity", "page.tsx");
    expect(src).toContain('import type { Metadata } from "next"');
    expect(src).toContain("LedgerPilot — Agent Activity & Webhook Audit");
    expect(src).toContain('id="main-content"');
    expect(src).toContain("tabIndex={-1}");
    expect(src).toContain('href="/"');
    expect(src).toContain('href="/judge"');
    expect(src).toContain("<ActivityClient />");
  });

  it("the page states the read-only rule: no executing, approving, or money movement here", () => {
    const src = read("activity", "page.tsx");
    expect(src).toMatch(/Read-only/);
    expect(src).toMatch(/append-only/);
  });

  it("the client loads the same console activity route the home grid uses — no new data path", () => {
    const src = read("activity", "activity-client.tsx");
    expect(src).toContain('fetch("/api/console/activity")');
    // Exactly one fetch, and it is a plain GET of the read model.
    expect(src.match(/fetch\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/method:\s*"POST"/);
  });

  it("the client renders the audit grid with the console's columns plus the detail payload", () => {
    const src = read("activity", "activity-client.tsx");
    for (const field of ["createdAt", "kind", "planId", "eventId", "summary", "detailJson"]) {
      expect(src).toContain(`field: "${field}"`);
    }
    expect(src).toContain("AgGridReact<ActivityRow>");
    expect(src).toContain("ModuleRegistry.registerModules([AllCommunityModule])");
  });

  it("the client reuses the console's state + export view-models instead of inventing its own", () => {
    const src = read("activity", "activity-client.tsx");
    expect(src).toContain("resolveGridOverlay");
    expect(src).toContain("buildOverlayTemplate");
    expect(src).toContain("gridCaption");
    expect(src).toContain("GRID_TITLES.activity");
    expect(src).toContain('buildCsvExportParams("activity")');
    expect(src).toContain("csvExportBlockReason");
    expect(src).toContain("exportDataAsCsv");
  });

  it("the client never calls a mutating endpoint", () => {
    const src = read("activity", "activity-client.tsx");
    expect(src).not.toContain("/api/agent/");
    expect(src).not.toContain("/api/paypal/");
    expect(src).not.toContain("/api/judge/");
  });

  it("the home page links to /activity", () => {
    expect(read("page.tsx")).toContain('href="/activity"');
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

    const rows = buildActivityRows(store.listActivity());
    // Newest first, every row carrying the fields the page's columns bind.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.createdAt >= rows[rows.length - 1]!.createdAt).toBe(true);
    for (const row of rows) {
      expect(typeof row.id).toBe("string");
      expect(typeof row.kind).toBe("string");
      expect(typeof row.summary).toBe("string");
      expect(typeof row.detailJson).toBe("string");
    }
    // The executed invoice call is in the trace, under the spine plan.
    const call = rows.find((r) => r.kind === "paypal_call");
    expect(call?.planId).toBe(plan.id);
    expect(call?.summary).toContain("/v2/invoicing/invoices");
  });
});
