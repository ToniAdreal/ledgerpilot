import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { LedgerStore } from "../src/lib/agent/store";
import { BriefParseError, parseBrief } from "../src/lib/agent/parser";
import { executePlan } from "../src/lib/agent/executor";
import {
  DraftValidationError,
  draftInvoicePlan,
  draftOrderPlan,
  draftPayoutPlan,
  parseMoney,
} from "../src/lib/agent/drafts";
import { LlmExtractionError, validateLlmExtraction } from "../src/lib/agent/llm";
import { InvoicePaymentError, recordInvoicePayment } from "../src/lib/invoice";
import { emptyInvoiceForm, validateInvoiceForm } from "../src/lib/invoice/invoice-form";
import { emptySellForm, validateSellForm } from "../src/lib/checkout/order-form";
import { emptyBatchLine, validateBatchForm } from "../src/lib/batch/batch-builder";

// Sub-cent amounts (0.001–0.004) are greater than zero as numbers but
// format to "0.00" at the two decimal places every LedgerPilot money
// value is kept to. Before this suite, the drafts validator and the
// LLM validator checked the pre-rounding number and emitted a
// zero-value Money anyway — a "0.00" invoice / order / payout that
// each surface's own rule ("must be greater than zero") claims to
// refuse — and the record-payment leg would record a "0.00" payment
// as success. The rule now governs the emitted value on every
// amount-validating surface: drafts (which also backs the plan-edit
// path and the agent tool calls), the LLM validator, record-payment,
// and the three console form mirrors. The brief parser was already
// safe by construction (its regex captures at most two decimals).

describe("sub-cent amounts — the drafts validator refuses what rounds to 0.00", () => {
  it.each([0.001, 0.004, "0.001", "0.004"])("draftInvoicePlan amount %s is refused, naming the 0.01 floor", (amount) => {
    expect(() => draftInvoicePlan({ recipientName: "Ana", amount, description: "logo work" })).toThrow(
      DraftValidationError,
    );
    expect(() => draftInvoicePlan({ recipientName: "Ana", amount, description: "logo work" })).toThrow(
      /at least 0\.01/,
    );
  });

  it("draftOrderPlan and the single draftPayoutPlan refuse sub-cent amounts", () => {
    expect(() => draftOrderPlan({ description: "logo pack", amount: 0.002 })).toThrow(/at least 0\.01/);
    expect(() => draftPayoutPlan({ recipientName: "Marco", amount: 0.001 })).toThrow(/at least 0\.01/);
  });

  it("a batch line's sub-cent amount is refused with the line named", () => {
    expect(() =>
      draftPayoutPlan({
        items: [
          { recipientName: "Marco", amount: 200 },
          { recipientName: "Ana", amount: 0.003 },
        ],
      }),
    ).toThrow(/items\[1\]: 'amount' must be at least 0\.01/);
  });

  it("parseMoney — the shared validator the edit path and tool calls use — refuses sub-cent", () => {
    expect(() => parseMoney(0.001, "USD")).toThrow(DraftValidationError);
    expect(() => parseMoney("0.004", "EUR")).toThrow(/at least 0\.01/);
  });

  it("the boundary is the emitted value: 0.01 is accepted, and 0.005 is accepted as the 0.01 it formats to", () => {
    const cent = draftInvoicePlan({ recipientName: "Ana", amount: 0.01, description: "logo work" });
    expect(cent.steps[0]!.payload).toMatchObject({
      items: [{ unit_amount: { currency_code: "USD", value: "0.01" } }],
    });
    const halfCent = draftPayoutPlan({ recipientName: "Marco", amount: 0.005 });
    expect(halfCent.steps[0]!.payload).toMatchObject({ amount: { currency_code: "USD", value: "0.01" } });
  });
});

describe("sub-cent amounts — the LLM validator refuses what rounds to 0.00", () => {
  it("a sub-cent LLM-proposed amount rejects the extraction", () => {
    expect(() =>
      validateLlmExtraction({
        steps: [{ type: "create_invoice", recipient: "Ana", amount: 0.001, currency: "USD", description: "logo work" }],
      }),
    ).toThrow(LlmExtractionError);
    expect(() =>
      validateLlmExtraction({
        steps: [{ type: "create_invoice", recipient: "Ana", amount: 0.001, currency: "USD", description: "logo work" }],
      }),
    ).toThrow(/at least 0\.01/);
  });

  it("one sub-cent step rejects the whole extraction, and 0.01 is accepted", () => {
    expect(() =>
      validateLlmExtraction({
        steps: [
          { type: "create_invoice", recipient: "Ana", amount: 450, currency: "USD", description: "logo work" },
          { type: "draft_payout", recipient: "Marco", amount: "0.004", currency: "USD" },
        ],
      }),
    ).toThrow(/at least 0\.01/);
    const ok = validateLlmExtraction({
      steps: [{ type: "draft_payout", recipient: "Marco", amount: 0.01, currency: "USD" }],
    });
    expect(ok.steps[0]!.amount).toBe("0.01");
  });
});

describe("sub-cent amounts — record-payment never records a 0.00 payment", () => {
  it("a 0.001 payment is refused 422 with nothing recorded; 0.01 records for real", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    const plan = store.addPlan(
      parseBrief("Invoice Ana $450 for brand work, due Friday", { now: new Date("2026-10-10T12:00:00Z") }),
    );
    store.approvePlan(plan.id);
    await executePlan(store, client, plan.id);
    const invoiceId = (await client.listInvoices())[0]!.id;
    const transactionsBefore = (await client.listTransactions()).length;

    await expect(recordInvoicePayment(client, store, invoiceId, { amount: "0.001" })).rejects.toThrow(
      InvoicePaymentError,
    );
    await expect(recordInvoicePayment(client, store, invoiceId, { amount: "0.001" })).rejects.toThrow(
      /rounds to 0\.00/,
    );
    await expect(recordInvoicePayment(client, store, invoiceId, { amount: "0.004" })).rejects.toMatchObject({
      status: 422,
    });
    expect((await client.listInvoices())[0]!.status).toBe("SENT");
    expect((await client.listTransactions()).length).toBe(transactionsBefore);

    const recorded = await recordInvoicePayment(client, store, invoiceId, { amount: "0.01" });
    expect(recorded.alreadyPaid).toBe(false);
    expect(recorded.invoice.recordedAmount).toBe("0.01");
    expect((await client.listInvoices())[0]!.status).toBe("PARTIALLY_PAID");
  });
});

describe("sub-cent amounts — the console form mirrors refuse them before submit", () => {
  it("invoice form: 0.001 is an amount error naming the floor; 0.01 is clean", () => {
    const bad = validateInvoiceForm({
      ...emptyInvoiceForm(),
      recipientName: "Ana",
      description: "Brand work",
      amount: "0.001",
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.find((e) => e.field === "amount")?.message).toMatch(/at least 0\.01/);
    const good = validateInvoiceForm({
      ...emptyInvoiceForm(),
      recipientName: "Ana",
      description: "Brand work",
      amount: "0.01",
    });
    expect(good.errors.find((e) => e.field === "amount")).toBeUndefined();
  });

  it("sell form: 0.004 is an amount error; 0.01 is clean", () => {
    const bad = validateSellForm({ ...emptySellForm(), description: "Logo pack", amount: "0.004" });
    expect(bad.ok).toBe(false);
    expect(bad.errors.find((e) => e.field === "amount")?.message).toMatch(/at least 0\.01/);
    const good = validateSellForm({ ...emptySellForm(), description: "Logo pack", amount: "0.01" });
    expect(good.errors.find((e) => e.field === "amount")).toBeUndefined();
  });

  it("batch builder: a sub-cent line is an amount error on that line; 0.01 is clean", () => {
    const bad = validateBatchForm([{ ...emptyBatchLine(), recipientName: "Marco", amount: "0.003" }]);
    expect(bad.ok).toBe(false);
    expect(bad.errors.find((e) => e.field === "amount")?.message).toMatch(/at least 0\.01/);
    const good = validateBatchForm([{ ...emptyBatchLine(), recipientName: "Marco", amount: "0.01" }]);
    expect(good.errors.find((e) => e.field === "amount")).toBeUndefined();
  });
});

describe("sub-cent amounts — the brief parser was already safe by construction", () => {
  it("a $0.001 brief is refused with no plan: the amount regex captures at most two decimals, so the brief matches no money action at all", () => {
    expect(() => parseBrief("Invoice Ana $0.001 for logo work", { now: new Date("2026-10-10T00:00:00Z") })).toThrow(
      BriefParseError,
    );
    expect(() => parseBrief("Invoice Ana $0.001 for logo work", { now: new Date("2026-10-10T00:00:00Z") })).toThrow(
      /No money action found/,
    );
    const plan = parseBrief("Invoice Ana $0.01 for logo work", { now: new Date("2026-10-10T00:00:00Z") });
    expect(plan.steps[0]!.payload).toMatchObject({
      items: [{ unit_amount: { currency_code: "USD", value: "0.01" } }],
    });
  });
});
