import { describe, expect, it } from "vitest";
import {
  EXAMPLE_BRIEFS,
  MAX_BRIEF_LENGTH,
  availableActions,
  buildPlanReview,
  pendingPlans,
  statusMessage,
  summarizeOutcomes,
  validateBrief,
} from "../src/lib/command";
import { parseBrief } from "../src/lib/agent";
import type { ActionPlan } from "../src/lib/types";

const NOW = new Date("2026-10-10T12:00:00Z");

function planWith(status: ActionPlan["status"]): ActionPlan {
  const plan = parseBrief(
    "Invoice Ana $450 for brand work, due Friday. When it lands, pay $200 to my contractor Marco.",
    { now: NOW },
  );
  return { ...plan, status };
}

describe("validateBrief", () => {
  it("trims and accepts a normal brief", () => {
    expect(validateBrief("  Invoice Ana $450  ")).toEqual({ ok: true, brief: "Invoice Ana $450" });
  });

  it("rejects empty and whitespace-only briefs", () => {
    expect(validateBrief("").ok).toBe(false);
    expect(validateBrief("   \n ").ok).toBe(false);
  });

  it("rejects briefs over the length cap", () => {
    const result = validateBrief("x".repeat(MAX_BRIEF_LENGTH + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(String(MAX_BRIEF_LENGTH));
  });
});

describe("availableActions mirrors the server-side approval gate", () => {
  it("pending_approval can be approved or rejected, never executed", () => {
    expect(availableActions("pending_approval")).toEqual({ canApprove: true, canReject: true, canExecute: false, canEdit: true });
  });

  it("approved can execute, and can no longer be approved or rejected", () => {
    expect(availableActions("approved")).toEqual({ canApprove: false, canReject: false, canExecute: true, canEdit: false });
  });

  it("terminal and in-flight statuses offer no actions", () => {
    for (const status of ["rejected", "executing", "awaiting_trigger", "completed", "failed"] as const) {
      expect(availableActions(status)).toEqual({ canApprove: false, canReject: false, canExecute: false, canEdit: false });
    }
  });
});

describe("buildPlanReview", () => {
  it("renders the demo-spine plan with exact PayPal calls and the gated payout marked", () => {
    const review = buildPlanReview(planWith("pending_approval"));
    expect(review.steps).toHaveLength(2);
    expect(review.immediateCount).toBe(1);
    expect(review.gatedCount).toBe(1);

    const [invoice, payout] = review.steps;
    expect(invoice!.typeLabel).toBe("Create invoice");
    expect(invoice!.callLabel).toContain("/v2/invoicing/invoices");
    expect(invoice!.gated).toBe(false);
    expect(invoice!.triggerLabel).toBeNull();

    expect(payout!.typeLabel).toBe("Draft payout");
    expect(payout!.callLabel).toContain("/v1/payments/payouts");
    expect(payout!.gated).toBe(true);
    expect(payout!.triggerLabel).toBe("Runs after INVOICING.INVOICE.PAID");
    expect(review.actions.canApprove).toBe(true);
  });

  it("an executed plan offers no further actions", () => {
    const review = buildPlanReview(planWith("awaiting_trigger"));
    expect(review.actions).toEqual({ canApprove: false, canReject: false, canExecute: false, canEdit: false });
  });
});

describe("pendingPlans", () => {
  it("keeps only plans awaiting a decision", () => {
    const plans = [planWith("pending_approval"), planWith("approved"), planWith("rejected"), planWith("pending_approval")];
    expect(pendingPlans(plans)).toHaveLength(2);
    expect(pendingPlans([])).toEqual([]);
  });
});

describe("summarizeOutcomes", () => {
  it("summarizes executed, deferred, and failed steps from the execute wire shape", () => {
    const text = summarizeOutcomes([
      { type: "create_invoice", outcome: "executed", resultId: "INV2-000001" },
      { type: "draft_payout", outcome: "deferred" },
      { type: "create_order", outcome: "failed", error: "boom" },
    ]);
    expect(text).toContain("Create invoice: done (INV2-000001)");
    expect(text).toContain("Draft payout: deferred");
    expect(text).toContain("Create checkout order: FAILED — boom");
  });

  it("handles an empty outcome list", () => {
    expect(summarizeOutcomes([])).toContain("no steps");
  });
});

describe("statusMessage", () => {
  it("states the approval invariant for a pending plan", () => {
    expect(statusMessage("pending_approval")).toContain("Nothing has executed");
  });

  it("explains that awaiting_trigger resumes via events, not another execute", () => {
    expect(statusMessage("awaiting_trigger")).toContain("trigger event");
  });
});

describe("EXAMPLE_BRIEFS", () => {
  it("every example brief parses into a plan — the chips can never offer a dead end", () => {
    expect(EXAMPLE_BRIEFS.length).toBeGreaterThanOrEqual(3);
    for (const ex of EXAMPLE_BRIEFS) {
      const plan = parseBrief(ex.brief, { now: NOW });
      expect(plan.steps.length, ex.label).toBeGreaterThanOrEqual(1);
      expect(validateBrief(ex.brief).ok, ex.label).toBe(true);
    }
    const types = EXAMPLE_BRIEFS.map((ex) => parseBrief(ex.brief, { now: NOW }).steps[0]!.type);
    expect(types).toContain("create_invoice");
    expect(types).toContain("create_order");
    expect(types).toContain("send_reminder");
  });

  it("the demo-spine example carries the gated payout", () => {
    const spine = EXAMPLE_BRIEFS[0]!;
    const review = buildPlanReview(parseBrief(spine.brief, { now: NOW }));
    expect(review.gatedCount).toBe(1);
  });
});
