import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { LedgerStore } from "../src/lib/agent/store";
import { executePlan } from "../src/lib/agent/executor";
import { draftPayoutPlan, MAX_PAYOUT_BATCH_ITEMS } from "../src/lib/agent/drafts";
import {
  EXAMPLE_BATCH_LINES,
  addBatchLine,
  batchPreviewSummary,
  batchTotalsPreview,
  buildBatchRequestBody,
  canAddLine,
  canRemoveLine,
  emptyBatchLine,
  lineFieldError,
  removeBatchLine,
  updateBatchLine,
  validateBatchForm,
} from "../src/lib/batch";

/**
 * Payout batch builder form (CONCEPT.md §3.1) — the console UI chunk
 * on top of the batch data path (tests/payout-batches.test.ts).
 *
 * These tests pin the form's pure view-model: line editing guards,
 * the per-line validation mirror (same rules the server enforces),
 * request-body building, per-currency totals, and — the guarantee
 * that matters — a body built from the form (example included) is
 * accepted by the real draftPayoutPlan and executes as one batch
 * through the approval gate.
 */

const VALID_LINE = { recipientName: "Marco", recipientEmail: "", amount: "200", currency: "USD", note: "" };

describe("batch builder — line editing", () => {
  it("starts from one empty USD line and edits immutably", () => {
    const line = emptyBatchLine();
    expect(line).toEqual({ recipientName: "", recipientEmail: "", amount: "", currency: "USD", note: "" });
    const lines = addBatchLine([line]);
    expect(lines).toHaveLength(2);
    const edited = updateBatchLine(lines, 1, { recipientName: "Ana", amount: "50.5" });
    expect(edited[1]).toMatchObject({ recipientName: "Ana", amount: "50.5" });
    expect(edited[0]).toBe(line);
    expect(lines[1]!.recipientName).toBe("");
  });

  it("add/remove guards respect the 1..MAX line window", () => {
    expect(canRemoveLine(1)).toBe(false);
    expect(canRemoveLine(2)).toBe(true);
    expect(canAddLine(MAX_PAYOUT_BATCH_ITEMS - 1)).toBe(true);
    expect(canAddLine(MAX_PAYOUT_BATCH_ITEMS)).toBe(false);
    const one = [emptyBatchLine()];
    expect(removeBatchLine(one, 0)).toBe(one);
    const full = Array.from({ length: MAX_PAYOUT_BATCH_ITEMS }, () => emptyBatchLine());
    expect(addBatchLine(full)).toBe(full);
    expect(removeBatchLine([emptyBatchLine(), emptyBatchLine()], 5)).toHaveLength(2);
    expect(removeBatchLine([emptyBatchLine(), emptyBatchLine()], 0)).toHaveLength(1);
  });
});

describe("batch builder — validation mirror", () => {
  it("accepts a valid form, including comma amounts and lowercase currency", () => {
    const v = validateBatchForm([
      { ...VALID_LINE, amount: "1,200" },
      { recipientName: "Ana", recipientEmail: "ana@example.com", amount: "50.5", currency: "eur", note: "x" },
    ]);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it("names the failing line and field for every rule the server enforces", () => {
    const v = validateBatchForm([
      VALID_LINE,
      { recipientName: " ", recipientEmail: "not-an-email", amount: "0", currency: "JPY", note: "" },
      { recipientName: "Ana", recipientEmail: "", amount: "abc", currency: "USD", note: "" },
      { recipientName: "Sam", recipientEmail: "", amount: "100001", currency: "USD", note: "" },
    ]);
    expect(v.ok).toBe(false);
    expect(lineFieldError(v, 1, "recipientName")).toMatch(/'recipientName' is required/);
    expect(lineFieldError(v, 1, "recipientEmail")).toMatch(/valid email/);
    expect(lineFieldError(v, 1, "amount")).toMatch(/greater than zero/);
    expect(lineFieldError(v, 1, "currency")).toMatch(/one of USD, EUR, GBP/);
    expect(lineFieldError(v, 2, "amount")).toMatch(/must be a number/);
    expect(lineFieldError(v, 3, "amount")).toMatch(/must not exceed 100000/);
    expect(lineFieldError(v, 0, "amount")).toBeNull();
  });

  it("an empty amount is a required error, and an empty batch is a form error", () => {
    const v = validateBatchForm([emptyBatchLine()]);
    expect(lineFieldError(v, 0, "amount")).toMatch(/is required/);
    const empty = validateBatchForm([]);
    expect(empty.ok).toBe(false);
    expect(empty.errors[0]).toMatchObject({ lineIndex: null, field: "items" });
  });

  it("over-long batch note is a form-level error", () => {
    const v = validateBatchForm([VALID_LINE], { note: "x".repeat(501) });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.lineIndex === null && e.field === "note")).toBe(true);
  });
});

describe("batch builder — request body + totals", () => {
  it("builds the server body: numbers parsed, currency normalised, empties omitted", () => {
    const body = buildBatchRequestBody(
      [
        { recipientName: " Marco ", recipientEmail: "", amount: "1,200", currency: "usd", note: "" },
        { recipientName: "Ana", recipientEmail: " ana@example.com ", amount: "50.5", currency: "eur", note: " share " },
      ],
      { note: " October run ", payWhenInvoicePaid: " INV2-000001 " },
    );
    expect(body).toEqual({
      items: [
        { recipientName: "Marco", amount: 1200, currency: "USD" },
        { recipientName: "Ana", recipientEmail: "ana@example.com", amount: 50.5, currency: "EUR", note: "share" },
      ],
      note: "October run",
      payWhenInvoicePaid: "INV2-000001",
    });
  });

  it("totals stay per currency and skip invalid lines; the preview names the gate", () => {
    const lines = [
      { ...VALID_LINE, amount: "200" },
      { ...VALID_LINE, recipientName: "Sam Rivera", amount: "25" },
      { recipientName: "Ana", recipientEmail: "", amount: "50.5", currency: "EUR", note: "" },
      { recipientName: "Bad", recipientEmail: "", amount: "abc", currency: "USD", note: "" },
    ];
    expect(batchTotalsPreview(lines)).toEqual([
      { currency_code: "USD", value: "225.00" },
      { currency_code: "EUR", value: "50.50" },
    ]);
    expect(batchPreviewSummary(lines)).toBe("4 lines · USD 225.00 + EUR 50.50");
    expect(batchPreviewSummary(lines, { payWhenInvoicePaid: "INV2-000001" })).toContain("gated on invoice INV2-000001");
    expect(batchPreviewSummary([emptyBatchLine()])).toBe("1 line · no amounts yet");
  });

  it("the example batch validates and its body is accepted by the real server draft", () => {
    expect(validateBatchForm(EXAMPLE_BATCH_LINES).ok).toBe(true);
    const plan = draftPayoutPlan(buildBatchRequestBody(EXAMPLE_BATCH_LINES));
    expect(plan.status).toBe("pending_approval");
    const items = (plan.steps[0]!.payload as { items: unknown[] }).items;
    expect(items).toHaveLength(3);
  });
});

describe("batch builder — full loop through the gate", () => {
  it("a form-built batch drafts, refuses unapproved execution, then pays as ONE batch", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    const body = buildBatchRequestBody(EXAMPLE_BATCH_LINES, { note: "October contractor run" });
    const plan = store.addPlan(draftPayoutPlan(body));
    await expect(executePlan(store, client, plan.id)).rejects.toThrow(/approval/);
    expect(await client.listPayouts()).toHaveLength(0);

    store.approvePlan(plan.id);
    const result = await executePlan(store, client, plan.id);
    expect(result.plan.status).toBe("completed");
    const batches = await client.listPayouts();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.items).toHaveLength(3);
    expect(batches[0]!.items.map((i) => i.transaction_status)).toEqual(["SUCCESS", "SUCCESS", "SUCCESS"]);
    // Lines without their own note fell back to the batch note (draft layer).
    const payloadItems = (plan.steps[0]!.payload as { items: Array<{ note: string }> }).items;
    expect(payloadItems[0]!.note).toBe("Brand work share");
    expect(payloadItems[1]!.note).toBe("October contractor run");
    const txns = await client.listTransactions();
    expect(txns.map((t) => t.transaction_amount.value)).toEqual(["-200.00", "-50.50", "-25.00"]);
  });
});
