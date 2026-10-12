import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { buildDisputeRows } from "../src/lib/console/read-models";
import { getDisputeEvidenceSummary } from "../src/lib/disputes";

const appDir = join(process.cwd(), "src", "app");
const read = (...parts: string[]) => readFileSync(join(appDir, ...parts), "utf8");

// The standalone /disputes page. The Disputes grid already
// lived on the console home as a read-only surface (with the
// draft-only evidence summary of CONCEPT.md §1 AI component
// (3)); this page is that list as its own route. It must
// reuse the console's data path and view-models — a second,
// divergent disputes view would break the one-console story.
describe("Disputes page (/disputes — the disputes list's own page)", () => {
  it("the page carries typed metadata, the skip target, and routes back to the console + Judge Mode", () => {
    const src = read("disputes", "page.tsx");
    expect(src).toContain('import type { Metadata } from "next"');
    expect(src).toContain("LedgerPilot — Disputes");
    expect(src).toContain('id="main-content"');
    expect(src).toContain("tabIndex={-1}");
    expect(src).toContain('href="/"');
    expect(src).toContain('href="/judge"');
    expect(src).toContain("<DisputesClient />");
  });

  it("the page states the read-only rule and the draft-only evidence rule", () => {
    const src = read("disputes", "page.tsx");
    expect(src).toMatch(/read-only/);
    expect(src).toMatch(/never submitted/);
    expect(src).toMatch(/Sample/);
  });

  it("the client loads the same console disputes route the home grid uses — no new data path", () => {
    const src = read("disputes", "disputes-client.tsx");
    expect(src).toContain('fetch("/api/console/disputes")');
    expect(src).not.toMatch(/method:\s*"POST"/);
  });

  it("the client renders the disputes grid with the console's columns", () => {
    const src = read("disputes", "disputes-client.tsx");
    for (const field of [
      "id",
      "buyerName",
      "buyerEmail",
      "status",
      "stage",
      "reason",
      "currency",
      "amountValue",
      "responseDueDate",
      "sample",
    ]) {
      expect(src).toContain(`field: "${field}"`);
    }
    expect(src).toContain("AgGridReact<DisputeRow>");
    expect(src).toContain("ModuleRegistry.registerModules([AllCommunityModule])");
  });

  it("the evidence draft is carried over as a GET-only, never-submitted draft", () => {
    const src = read("disputes", "disputes-client.tsx");
    // The evidence summary loads from the same GET route the
    // console uses, and the panel labels the draft as not
    // submitted — the Disputes integration stays read-only.
    expect(src).toContain("/evidence`");
    expect(src).toContain("encodeURIComponent(disputeId)");
    expect(src).toContain("Evidence draft");
    expect(src).toContain("Draft response (not submitted)");
    expect(src).toContain("evidenceSummary.disclaimer");
  });

  it("the client reuses the console's state + export view-models instead of inventing its own", () => {
    const src = read("disputes", "disputes-client.tsx");
    expect(src).toContain("resolveGridOverlay");
    expect(src).toContain("buildOverlayTemplate");
    expect(src).toContain("gridCaption");
    expect(src).toContain("GRID_TITLES.disputes");
    expect(src).toContain('buildCsvExportParams("disputes")');
    expect(src).toContain("csvExportBlockReason");
    expect(src).toContain("exportDataAsCsv");
  });

  it("the client never calls a mutating endpoint", () => {
    const src = read("disputes", "disputes-client.tsx");
    expect(src).not.toContain("/api/agent/");
    expect(src).not.toContain("/api/paypal/");
    expect(src).not.toContain("/api/judge/");
  });

  it("the home page links to /disputes", () => {
    expect(read("page.tsx")).toContain('href="/disputes"');
  });

  it("the rows the page renders are the read model's rows for the mock dispute set", async () => {
    const client = new MockPayPalClient();
    const rows = buildDisputeRows(await client.listDisputes(), "2026-10-10");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe("PP-D-SAMPLE-001");
    expect(row.buyerName).toBe("Sam Rivera");
    expect(row.status).toBe("WAITING_FOR_SELLER_RESPONSE");
    expect(row.currency).toBe("USD");
    expect(row.amount).toBe("120.00");
    expect(row.responseDueDate).toBe("2026-10-29T23:59:59Z");
    expect(row.responseOverdue).toBe(false);
    expect(row.sample).toBe(true);
  });

  it("the evidence summary the page drafts is the adapter-backed draft for the sample dispute", async () => {
    const client = new MockPayPalClient();
    const summary = await getDisputeEvidenceSummary(client, "PP-D-SAMPLE-001", "2026-10-10");
    expect(summary.disputeId).toBe("PP-D-SAMPLE-001");
    expect(summary.sample).toBe(true);
    expect(summary.buyerName).toBe("Sam Rivera");
    expect(summary.draftResponse).toContain("NOT SUBMITTED");
  });
});
