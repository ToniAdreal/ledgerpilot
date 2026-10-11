import { describe, expect, it } from "vitest";
import {
  SyncResultError,
  parseSyncWireResult,
  summarizeSyncResult,
  syncBlockReason,
  type SyncWireResult,
} from "../src/lib/console/sync";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { LedgerStore } from "../src/lib/agent/store";
import { parseBrief } from "../src/lib/agent/parser";
import { executePlan } from "../src/lib/agent/executor";
import { syncFromPayPal } from "../src/lib/agent/reconciler";

const REF = new Date("2026-10-10T00:00:00Z");

function wire(overrides: Partial<SyncWireResult> = {}): SyncWireResult {
  return {
    checked: { invoices: 3, orders: 1, payouts: 1, emittedEvents: 3 },
    processedEventIds: [],
    alreadyProcessedEventIds: [],
    resumedPlans: [],
    state: { invoices: [], orders: [], payouts: [] },
    ...overrides,
  };
}

describe("sync wire validation", () => {
  it("accepts the route's shape and returns a defensive copy of the lists", () => {
    const input = wire({ processedEventIds: ["WH-1"], resumedPlans: ["plan-0001"] });
    const parsed = parseSyncWireResult(input);
    expect(parsed).toEqual(input);
    parsed.processedEventIds.push("WH-2");
    expect(input.processedEventIds).toEqual(["WH-1"]);
  });

  it("rejects non-object payloads and malformed fields with the field named", () => {
    expect(() => parseSyncWireResult(null)).toThrow(SyncResultError);
    expect(() => parseSyncWireResult("sync")).toThrow(/must be a JSON object/);
    expect(() => parseSyncWireResult(wire({ checked: { invoices: -1, orders: 0, payouts: 0, emittedEvents: 0 } }))).toThrow(
      /checked\.invoices/,
    );
    expect(() => parseSyncWireResult({ ...wire(), processedEventIds: [42] })).toThrow(/processedEventIds/);
    expect(() => parseSyncWireResult({ ...wire(), resumedPlans: "plan-0001" })).toThrow(/resumedPlans/);
    expect(
      () => parseSyncWireResult({ ...wire(), state: { invoices: [{ id: 7, status: "PAID" }], orders: [], payouts: [] } }),
    ).toThrow(/state\.invoices\[0\]/);
  });
});

describe("sync outcome summary", () => {
  it("headlines a resumed plan (money moving) over processed events", () => {
    const summary = summarizeSyncResult(
      wire({ processedEventIds: ["WH-1", "WH-2"], alreadyProcessedEventIds: ["WH-0"], resumedPlans: ["plan-0001"] }),
    );
    expect(summary.headline).toBe("Sync resumed 1 plan: plan-0001");
    expect(summary.hadWork).toBe(true);
    expect(summary.newlyProcessedCount).toBe(2);
    expect(summary.detail).toContain("Checked 3 invoices, 1 order, 1 payout batch and 3 emitted events.");
    expect(summary.detail).toContain("2 newly processed, 1 already processed.");
  });

  it("headlines newly processed events when no plan resumed, with plural forms", () => {
    const summary = summarizeSyncResult(
      wire({
        checked: { invoices: 1, orders: 2, payouts: 2, emittedEvents: 1 },
        processedEventIds: ["WH-1", "WH-2"],
        resumedPlans: [],
      }),
    );
    expect(summary.headline).toBe("Sync processed 2 new events");
    expect(summary.detail).toContain("1 invoice, 2 orders, 2 payout batches and 1 emitted event");
  });

  it("reports an idempotent re-run honestly as nothing new", () => {
    const summary = summarizeSyncResult(wire({ alreadyProcessedEventIds: ["WH-1", "WH-2", "WH-3"] }));
    expect(summary.headline).toBe("Sync complete — nothing new to reconcile");
    expect(summary.hadWork).toBe(false);
    expect(summary.detail).toContain("0 newly processed, 3 already processed.");
  });
});

describe("sync gating", () => {
  it("blocks only while a sync is already in progress", () => {
    expect(syncBlockReason({ syncing: true })).toMatch(/already in progress/);
    expect(syncBlockReason({ syncing: false })).toBeNull();
  });
});

describe("sync over a real reconciler run (the console action's backend)", () => {
  it("the wire shape the route sends parses, and its summary names the resumed spine plan", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    const plan = parseBrief(
      "Invoice Ana $450 for logo work, due Friday. When it lands, pay $200 to my contractor Marco.",
      { now: REF },
    );
    store.addPlan(plan);
    store.approvePlan(plan.id);
    const executed = await executePlan(store, client, plan.id);
    expect(executed.plan.status).toBe("awaiting_trigger");
    const invoiceId = executed.outcomes[0].resultId!;
    await client.recordInvoicePayment(invoiceId, { value: "450.00", currency_code: "USD" });

    const result = await syncFromPayPal(store, client);
    // Exactly the JSON the route returns (route.ts maps resumed -> ids).
    const wireResult = {
      checked: result.checked,
      processedEventIds: result.processedEventIds,
      alreadyProcessedEventIds: result.alreadyProcessedEventIds,
      resumedPlans: result.resumed.map((r) => r.plan.id),
      state: result.state,
    };
    const summary = summarizeSyncResult(parseSyncWireResult(wireResult));
    expect(summary.resumedPlanIds).toEqual([plan.id]);
    expect(summary.headline).toContain(plan.id);
    expect(store.getPlan(plan.id)?.status).toBe("completed");

    // A second sync is the idempotent no-op the summary describes.
    const second = await syncFromPayPal(store, client);
    const secondSummary = summarizeSyncResult(
      parseSyncWireResult({ ...wireResult, processedEventIds: second.processedEventIds, alreadyProcessedEventIds: second.alreadyProcessedEventIds, resumedPlans: [] }),
    );
    expect(secondSummary.headline).toBe("Sync complete — nothing new to reconcile");
  });
});
