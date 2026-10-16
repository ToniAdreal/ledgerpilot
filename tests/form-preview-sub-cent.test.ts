import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { batchPreviewSummary, batchTotalsPreview, emptyBatchLine } from "../src/lib/batch/batch-builder";
import { emptySellForm, sellPreviewSummary } from "../src/lib/checkout/order-form";
import { emptyInvoiceForm, invoicePreviewSummary } from "../src/lib/invoice/invoice-form";

// Form-preview sub-cent hygiene — the live previews of the three
// console money forms (invoice, sell, payout batch) are the one
// surface the sub-cent run (tests/sub-cent-amounts.test.ts) did
// not cover. Every validator on those forms refuses a sub-cent
// amount (0.001–0.004: positive as a number, but formats to
// "0.00" at two decimal places, naming the 0.01 floor), and each
// preview's own doc comment states its rule — "a preview must
// never present a guessed total as fact" / "invalid lines are
// skipped". Until this suite the previews checked only
// amount <= 0 and the cap, so a sub-cent amount passed their
// checks and was presented as a real "USD 0.00" total: the
// invoice and sell previews rendered "· USD 0.00", and the
// batch totals preview included the line and formatted its
// per-currency total as "0.00" instead of reporting no amounts.
// The previews now apply the same emitted-value rule the
// validators apply — Number(amount.toFixed(2)) <= 0 is not a
// valid amount — so a sub-cent amount reads as "no amount yet"
// (invoice/sell) or is skipped (batch). The boundary is the
// emitted value, exactly as in the validators: 0.01 previews
// normally, and 0.005 previews as the "0.01" it formats to.

describe("form previews — sub-cent amounts are not presented as 0.00 totals", () => {
  it.each(["0.001", "0.004"])("invoice preview: amount %s reads as no amount yet, never USD 0.00", (amount) => {
    const summary = invoicePreviewSummary({
      ...emptyInvoiceForm(),
      recipientName: "Ana",
      description: "Brand work",
      amount,
    });
    expect(summary).toBe("Invoice Ana · no amount yet");
    expect(summary).not.toContain("0.00");
  });

  it("invoice preview: 0.01 and 0.005 (which formats to 0.01) preview normally", () => {
    expect(
      invoicePreviewSummary({ ...emptyInvoiceForm(), recipientName: "Ana", description: "Brand work", amount: "0.01" }),
    ).toBe("Invoice Ana · USD 0.01 for Brand work");
    expect(
      invoicePreviewSummary({ ...emptyInvoiceForm(), recipientName: "Ana", description: "Brand work", amount: "0.005" }),
    ).toBe("Invoice Ana · USD 0.01 for Brand work");
  });

  it.each(["0.002", "0.004"])("sell preview: amount %s reads as no amount yet, never USD 0.00", (amount) => {
    const summary = sellPreviewSummary({ ...emptySellForm(), description: "Logo pack", amount });
    expect(summary).toBe("Logo pack · no amount yet");
    expect(summary).not.toContain("0.00");
  });

  it("sell preview: 0.01 and 0.005 preview normally", () => {
    expect(sellPreviewSummary({ ...emptySellForm(), description: "Logo pack", amount: "0.01" })).toBe(
      "Logo pack · USD 0.01",
    );
    expect(sellPreviewSummary({ ...emptySellForm(), description: "Logo pack", amount: "0.005" })).toBe(
      "Logo pack · USD 0.01",
    );
  });

  it("batch totals preview: a sole sub-cent line is skipped — no totals, summary says no amounts yet", () => {
    const lines = [{ ...emptyBatchLine(), recipientName: "Marco", amount: "0.003" }];
    expect(batchTotalsPreview(lines)).toEqual([]);
    expect(batchPreviewSummary(lines)).toBe("1 line · no amounts yet");
  });

  it("batch totals preview: sub-cent lines are skipped even when they would aggregate past a cent", () => {
    // Three 0.004 lines sum to 0.012, which formats to 0.01 — but
    // each line is individually invalid, so none may contribute.
    const lines = ["0.004", "0.004", "0.004"].map((amount) => ({
      ...emptyBatchLine(),
      recipientName: "Marco",
      amount,
    }));
    expect(batchTotalsPreview(lines)).toEqual([]);
  });

  it("batch totals preview: a sub-cent line does not drag a valid line's total, and valid lines still preview", () => {
    const lines = [
      { ...emptyBatchLine(), recipientName: "Marco", amount: "0.001" },
      { ...emptyBatchLine(), recipientName: "Ana", amount: "200" },
      { ...emptyBatchLine(), recipientName: "Sam Rivera", amount: "0.005", currency: "EUR" },
    ];
    expect(batchTotalsPreview(lines)).toEqual([
      { currency_code: "USD", value: "200.00" },
      { currency_code: "EUR", value: "0.01" },
    ]);
    expect(batchPreviewSummary(lines)).toBe("3 lines · USD 200.00 + EUR 0.01");
  });

  it("batch totals preview: 0.01 previews normally", () => {
    const lines = [{ ...emptyBatchLine(), recipientName: "Marco", amount: "0.01" }];
    expect(batchTotalsPreview(lines)).toEqual([{ currency_code: "USD", value: "0.01" }]);
  });

  it("is documented in the README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("Form-preview sub-cent hygiene");
    expect(readme).toContain("no amount yet");
  });
});
