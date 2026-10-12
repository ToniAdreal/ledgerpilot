import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { LedgerStore } from "../src/lib/agent/store";
import { parseBrief } from "../src/lib/agent/parser";
import { executePlan } from "../src/lib/agent/executor";
import { buildPlanReview } from "../src/lib/command";

const appDir = join(process.cwd(), "src", "app");
const read = (...parts: string[]) => readFileSync(join(appDir, ...parts), "utf8");

const NOW = new Date("2026-10-10T12:00:00Z");
const SPINE =
  "Invoice Ana $450 for brand work, due Friday. When it lands, pay $200 to my contractor Marco.";

// The standalone /command page (CONCEPT.md §3.1: "/command —
// (or console drawer) Agent plan review: the typed action plan
// rendered as a checklist with exact PayPal calls listed;
// Approve / Edit / Reject"). The Agent Command bar already
// lived on the console home; this page is that surface as its
// own route. Unlike the standalone list pages it is NOT
// read-only — plan review is the gate itself — but it must
// reuse the console's one CommandBar component and the
// /api/agent/* routes, never a second command implementation.
describe("Command page (/command — the plan review's own page)", () => {
  it("the page carries typed metadata, the skip target, and routes back to the console + Judge Mode", () => {
    const src = read("command", "page.tsx");
    expect(src).toContain('import type { Metadata } from "next"');
    expect(src).toContain("LedgerPilot — Agent Command");
    expect(src).toContain('id="main-content"');
    expect(src).toContain("tabIndex={-1}");
    expect(src).toContain('href="/"');
    expect(src).toContain('href="/judge"');
    expect(src).toContain("<CommandClient />");
  });

  it("the page states the approval-gate rule and names the plan-review checklist", () => {
    const src = read("command", "page.tsx");
    expect(src).toMatch(/Nothing\s+executes without approval/);
    expect(src).toMatch(/exact PayPal calls/);
    expect(src).toMatch(/trigger-gated/);
    expect(src).toMatch(/approval gate/);
  });

  it("the client renders the console's own CommandBar — no second implementation", () => {
    const src = read("command", "command-client.tsx");
    expect(src).toContain('"use client"');
    expect(src).toContain('import CommandBar from "../command-bar"');
    expect(src).toContain("<CommandBar onSettled={onSettled} />");
    // The wrapper itself calls no endpoint at all: every fetch
    // lives inside the shared CommandBar component.
    expect(src).not.toContain("fetch(");
  });

  it("the client never calls PayPal or Judge endpoints directly", () => {
    const src = read("command", "command-client.tsx");
    expect(src).not.toContain("/api/paypal/");
    expect(src).not.toContain("/api/judge/");
  });

  it("the shared CommandBar drives only the /api/agent/* gate routes", () => {
    const src = read("command-bar.tsx");
    expect(src).toContain('postJson("/api/agent/plan"');
    expect(src).toContain('postJson("/api/agent/approve"');
    expect(src).toContain('postJson("/api/agent/execute"');
    expect(src).toContain('fetch("/api/agent/plan")');
    expect(src).not.toContain("/api/paypal/");
  });

  it("the home page links to /command", () => {
    expect(read("page.tsx")).toContain('href="/command"');
  });

  it("the plan review the page renders lists the demo spine's exact calls with the payout gated", () => {
    const plan = parseBrief(SPINE, { now: NOW });
    const review = buildPlanReview(plan);
    expect(review.status).toBe("pending_approval");
    expect(review.immediateCount).toBe(1);
    expect(review.gatedCount).toBe(1);
    expect(review.steps.map((s) => s.callLabel).join(" ")).toContain("/v2/invoicing/invoices");
    expect(review.steps.map((s) => s.callLabel).join(" ")).toContain("/v1/payments/payouts");
    expect(review.steps[1]!.triggerLabel).toMatch(/INVOICING\.INVOICE\.PAID/);
    expect(review.actions).toEqual({ canApprove: true, canReject: true, canExecute: false });
  });

  it("a plan drafted for this page executes nothing until approved, then defers the gated payout", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    const plan = parseBrief(SPINE, { now: NOW });
    store.addPlan(plan);

    await expect(executePlan(store, client, plan.id)).rejects.toThrow();
    expect(await client.listInvoices()).toHaveLength(0);

    store.approvePlan(plan.id);
    const result = await executePlan(store, client, plan.id);
    expect(result.plan.status).toBe("awaiting_trigger");
    const invoices = await client.listInvoices();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.status).toBe("SENT");
    expect(await client.listPayouts()).toHaveLength(0);
  });
});
