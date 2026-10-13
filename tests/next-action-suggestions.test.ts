import { describe, expect, it } from "vitest";
import {
  LedgerStore,
  SuggestionError,
  draftReminderPlan,
  executePlan,
  resolveReferenceDate,
  suggestNextActions,
} from "@/lib/agent";
import {
  parseSuggestWireResult,
  suggestBlockReason,
  summarizeSuggestResult,
  SuggestResultError,
  type SuggestWireResult,
} from "@/lib/console";
import { seedJudgeScenario } from "@/lib/judge";
import { MockPayPalClient } from "@/lib/paypal";
import type { Party } from "@/lib/types";

/**
 * Next-action suggestions — CONCEPT.md §3.1's data flow ends with the
 * agent drafting the *next* action as a new pending plan. These tests
 * pin the reminder half of that sentence: the overdue scan (the read
 * model's own definition), draft-only-through-the-gate drafting with
 * steps identical to a hand-drafted reminder, the never-nag-twice
 * dedupe rules, and the console view-model that reports the outcome.
 */

const NOW = new Date("2026-10-10T12:00:00Z");
const REF = "2026-10-10";
const ANA: Party = { name: "Ana", email_address: "ana@example.com" };
const MARCO: Party = { name: "Marco", email_address: "marco@example.com" };

async function openInvoice(
  client: MockPayPalClient,
  recipient: Party,
  value: string,
  dueDate: string,
  currency: "USD" | "EUR" = "USD",
) {
  const draft = await client.createInvoice({
    recipient,
    items: [{ name: "Work", quantity: "1", unit_amount: { currency_code: currency, value } }],
    dueDate,
  });
  return client.sendInvoice(draft.id);
}

describe("suggestNextActions — the overdue scan", () => {
  it("drafts exactly one reminder plan for the Judge Mode scenario's overdue invoice", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    const seeded = await seedJudgeScenario(client, store, { now: NOW });

    const result = await suggestNextActions(client, store, { referenceDate: REF, now: NOW });
    expect(result.referenceDate).toBe(REF);
    expect(result.overdueCount).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(result.drafted).toHaveLength(1);

    const suggestion = result.drafted[0]!;
    // Marco's PARTIALLY_PAID EUR invoice: EUR 300 billed, EUR 100 paid, due 2026-10-01.
    expect(suggestion.recipientName).toBe("Marco");
    expect(suggestion.dueDate).toBe("2026-10-01");
    expect(suggestion.dueAmount).toEqual({ currency_code: "EUR", value: "200.00" });
    expect(suggestion.invoiceId).toBe(seeded.seed.invoiceIds[1]);

    const plan = suggestion.plan;
    expect(plan.status).toBe("pending_approval");
    expect(plan.source).toBe("suggested");
    expect(plan.id).toMatch(/^plan-suggested-\d{4}$/);
    expect(plan.brief).toContain("Suggestion:");
    expect(plan.brief).toContain(suggestion.invoiceNumber);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.type).toBe("send_reminder");
    expect(plan.steps[0]!.paypalCall).toEqual({ method: "POST", path: "/v2/invoicing/invoices/:id/remind" });
    // The reference is pinned to this invoice's number — never the
    // recipient's most-overdue, which could differ by execution time.
    expect(plan.steps[0]!.payload).toMatchObject({ invoiceRef: suggestion.invoiceNumber });
    // The step is identical to a hand-drafted reminder for the same target.
    const handDrafted = draftReminderPlan(
      { recipientName: "Marco", recipientEmail: "marco@example.com", invoiceRef: suggestion.invoiceNumber },
      { now: NOW },
    );
    expect(plan.steps[0]).toEqual(handDrafted.steps[0]);
    // The spine plan from seeding is untouched by the scan.
    expect(store.listPlans().filter((p) => p.source === "suggested")).toHaveLength(1);
  });

  it("drafts nothing when nothing is overdue — future-due, paid, and draft invoices never qualify", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    const future = await openInvoice(client, ANA, "100.00", "2026-10-20");
    await openInvoice(client, MARCO, "50.00", "2026-10-10"); // due today: not yet overdue
    const paid = await openInvoice(client, ANA, "75.00", "2026-10-01");
    await client.recordInvoicePayment(paid.id, { value: "75.00", currency_code: "USD" });
    await client.createInvoice({
      recipient: MARCO,
      items: [{ name: "Work", quantity: "1", unit_amount: { currency_code: "USD", value: "10.00" } }],
      dueDate: "2026-10-01",
    }); // stays DRAFT — never sent, so not remindable

    const result = await suggestNextActions(client, store, { referenceDate: REF, now: NOW });
    expect(result.overdueCount).toBe(0);
    expect(result.drafted).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(store.listPlans()).toHaveLength(0);
    expect(future.status).toBe("SENT");
  });

  it("orders suggestions most-overdue first", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    await openInvoice(client, ANA, "100.00", "2026-10-05");
    await openInvoice(client, MARCO, "200.00", "2026-09-20");

    const result = await suggestNextActions(client, store, { referenceDate: REF, now: NOW });
    expect(result.drafted.map((d) => d.recipientName)).toEqual(["Marco", "Ana"]);
    expect(result.drafted.map((d) => d.dueDate)).toEqual(["2026-09-20", "2026-10-05"]);
  });

  it("validates the reference date like the drafts validate due dates", async () => {
    expect(resolveReferenceDate(undefined, NOW)).toBe(REF);
    expect(resolveReferenceDate("2026-11-01", NOW)).toBe("2026-11-01");
    expect(() => resolveReferenceDate("10/10/2026", NOW)).toThrow(SuggestionError);
    expect(() => resolveReferenceDate("2026-02-30", NOW)).toThrow(/real calendar date/);
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    await openInvoice(client, ANA, "100.00", "2026-10-05");
    // At a reference date before the due date the invoice is not overdue.
    const early = await suggestNextActions(client, store, { referenceDate: "2026-10-01", now: NOW });
    expect(early.drafted).toHaveLength(0);
  });
});

describe("suggestNextActions — the gate and the never-nag-twice rules", () => {
  it("drafts only: nothing is sent, and executing an unapproved suggestion is refused", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    await seedJudgeScenario(client, store, { now: NOW });
    const result = await suggestNextActions(client, store, { referenceDate: REF, now: NOW });
    const plan = result.drafted[0]!.plan;

    expect(client.sentReminders).toHaveLength(0);
    await expect(executePlan(store, client, plan.id)).rejects.toThrow(/execution requires approval/);
    expect(client.sentReminders).toHaveLength(0);
  });

  it("a second run drafts nothing twice — the pending suggestion covers the invoice", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    await seedJudgeScenario(client, store, { now: NOW });
    const first = await suggestNextActions(client, store, { referenceDate: REF, now: NOW });
    const second = await suggestNextActions(client, store, { referenceDate: REF, now: NOW });
    expect(second.drafted).toEqual([]);
    expect(second.skipped).toEqual([
      {
        invoiceId: first.drafted[0]!.invoiceId,
        invoiceNumber: first.drafted[0]!.invoiceNumber,
        reason: "reminder_plan_exists",
        planId: first.drafted[0]!.plan.id,
        planStatus: "pending_approval",
      },
    ]);
  });

  it("the suggested plan executes for real after approval, and a later run reports already_reminded", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    await seedJudgeScenario(client, store, { now: NOW });
    const result = await suggestNextActions(client, store, { referenceDate: REF, now: NOW });
    const plan = result.drafted[0]!.plan;

    store.approvePlan(plan.id);
    const execution = await executePlan(store, client, plan.id);
    expect(execution.plan.status).toBe("completed");
    expect(client.sentReminders).toHaveLength(1);
    expect(client.sentReminders[0]!.invoiceId).toBe(result.drafted[0]!.invoiceId);

    const after = await suggestNextActions(client, store, { referenceDate: REF, now: NOW });
    expect(after.drafted).toEqual([]);
    expect(after.skipped).toEqual([
      { invoiceId: result.drafted[0]!.invoiceId, invoiceNumber: result.drafted[0]!.invoiceNumber, reason: "already_reminded" },
    ]);
  });

  it("a rejected suggestion is not re-drafted — the seller's no stands", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    await seedJudgeScenario(client, store, { now: NOW });
    const first = await suggestNextActions(client, store, { referenceDate: REF, now: NOW });
    store.rejectPlan(first.drafted[0]!.plan.id);

    const second = await suggestNextActions(client, store, { referenceDate: REF, now: NOW });
    expect(second.drafted).toEqual([]);
    expect(second.skipped[0]).toMatchObject({ reason: "reminder_plan_exists", planStatus: "rejected" });
  });

  it("a failed reminder plan does not block a fresh suggestion — its reminder never went out", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    const seeded = await seedJudgeScenario(client, store, { now: NOW });
    const failed = store.addPlan(
      draftReminderPlan(
        { recipientName: "Marco", recipientEmail: "marco@example.com", invoiceRef: seeded.seed.invoiceIds[1] },
        { now: NOW },
      ),
    );
    store.updatePlanStatus(failed.id, "failed");

    const result = await suggestNextActions(client, store, { referenceDate: REF, now: NOW });
    expect(result.drafted).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  it("a reference-less reminder plan covers the recipient's invoices by email", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    await seedJudgeScenario(client, store, { now: NOW });
    store.addPlan(draftReminderPlan({ recipientName: "Marco", recipientEmail: "marco@example.com" }, { now: NOW }));

    const result = await suggestNextActions(client, store, { referenceDate: REF, now: NOW });
    expect(result.drafted).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ reason: "reminder_plan_exists" });
  });
});

describe("console suggestions view-model", () => {
  const wire: SuggestWireResult = {
    referenceDate: REF,
    overdueCount: 2,
    drafted: [
      {
        planId: "plan-suggested-0001",
        planStatus: "pending_approval",
        invoiceId: "INV2-000004",
        invoiceNumber: "LP-000004",
        recipientName: "Marco",
        dueDate: "2026-10-01",
        dueAmount: { currency_code: "EUR", value: "200.00" },
      },
    ],
    skipped: [{ invoiceId: "INV2-000009", invoiceNumber: "LP-000009", reason: "already_reminded" }],
  };

  it("parses the route's wire shape from a real suggest result, JSON round-tripped", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    await seedJudgeScenario(client, store, { now: NOW });
    const result = await suggestNextActions(client, store, { referenceDate: REF, now: NOW });
    const parsed = parseSuggestWireResult(JSON.parse(JSON.stringify(result)));
    expect(parsed.referenceDate).toBe(REF);
    expect(parsed.overdueCount).toBe(1);
    expect(parsed.drafted[0]).toMatchObject({
      planId: result.drafted[0]!.plan.id,
      invoiceNumber: result.drafted[0]!.invoiceNumber,
      recipientName: "Marco",
      dueAmount: { currency_code: "EUR", value: "200.00" },
    });
  });

  it("rejects malformed wire payloads, naming the field", () => {
    expect(() => parseSuggestWireResult(null)).toThrow(SuggestResultError);
    expect(() => parseSuggestWireResult({ ...wire, overdueCount: -1 })).toThrow(/overdueCount/);
    expect(() => parseSuggestWireResult({ ...wire, drafted: [{ invoiceId: "x" }] })).toThrow(/drafted\[0\]\.plan/);
    expect(() => parseSuggestWireResult({ referenceDate: REF, overdueCount: 0, drafted: [], skipped: [{ invoiceId: "x" }] })).toThrow(/skipped\[0\]\.invoiceNumber/);
  });

  it("summarizes drafted, covered, and nothing-overdue runs honestly", () => {
    const draftedSummary = summarizeSuggestResult(wire);
    expect(draftedSummary.headline).toBe("Agent drafted 1 reminder plan for approval");
    expect(draftedSummary.detail).toContain("LP-000004");
    expect(draftedSummary.detail).toContain("plan-suggested-0001");
    expect(draftedSummary.detail).toContain("reminder already sent");
    expect(draftedSummary.detail).toContain("nothing is sent without approval");
    expect(draftedSummary.draftedAny).toBe(true);

    const covered = summarizeSuggestResult({ ...wire, drafted: [] });
    expect(covered.headline).toBe("No new suggestions — every overdue invoice is already covered");
    expect(covered.draftedAny).toBe(false);

    const none = summarizeSuggestResult({ referenceDate: REF, overdueCount: 0, drafted: [], skipped: [] });
    expect(none.headline).toBe("No overdue invoices — nothing to suggest");
    expect(none.detail).toContain(REF);
  });

  it("blocks only a second concurrent suggest run", () => {
    expect(suggestBlockReason({ suggesting: true })).not.toBeNull();
    expect(suggestBlockReason({ suggesting: false })).toBeNull();
  });
});
