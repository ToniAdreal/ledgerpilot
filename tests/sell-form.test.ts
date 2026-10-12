import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { LedgerStore } from "../src/lib/agent/store";
import { executePlan } from "../src/lib/agent/executor";
import { draftOrderPlan } from "../src/lib/agent/drafts";
import {
  EXAMPLE_SELL_FORM,
  buildOrderRequestBody,
  captureCheckoutOrder,
  emptySellForm,
  parseSellAmount,
  sellFieldError,
  sellPreviewSummary,
  validateSellForm,
} from "../src/lib/checkout";
import { buildOrderRows } from "../src/lib/console/read-models";

/**
 * Sell form (CONCEPT.md §3.1 "/checkout — 'Sell something' flow") —
 * the console UI chunk on top of the orders draft data path
 * (tests/api-drafts.test.ts).
 *
 * These tests pin the form's pure view-model: the validation mirror
 * (same rules the server enforces in draftOrderPlan), request-body
 * building, the live preview, and — the guarantee that matters — a
 * body built from the form (example included) is accepted by the
 * real draftOrderPlan and executes through the approval gate into a
 * CREATED order whose buyer view is payable, closing with capture.
 */

const VALID_FORM = { description: "Logo pack", amount: "75", currency: "USD", reference: "" };

describe("sell form — state + amount parsing", () => {
  it("starts empty with a USD default and parses amounts like the server", () => {
    expect(emptySellForm()).toEqual({ description: "", amount: "", currency: "USD", reference: "" });
    expect(parseSellAmount("1,200")).toBe(1200);
    expect(parseSellAmount(" 75.5 ")).toBe(75.5);
    expect(parseSellAmount("")).toBeNull();
    expect(parseSellAmount("abc")).toBeNull();
  });
});

describe("sell form — validation mirror", () => {
  it("accepts a valid form, including comma amounts and lowercase currency", () => {
    const v = validateSellForm({ ...VALID_FORM, amount: "1,200", currency: "eur" });
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it("names the failing field for every rule the server enforces", () => {
    const v = validateSellForm({ description: " ", amount: "0", currency: "JPY", reference: "x".repeat(501) });
    expect(v.ok).toBe(false);
    expect(sellFieldError(v, "description")).toMatch(/'description' is required/);
    expect(sellFieldError(v, "amount")).toMatch(/greater than zero/);
    expect(sellFieldError(v, "currency")).toMatch(/one of USD, EUR, GBP/);
    expect(sellFieldError(v, "reference")).toMatch(/at most 500/);

    expect(sellFieldError(validateSellForm({ ...VALID_FORM, amount: "" }), "amount")).toMatch(/is required/);
    expect(sellFieldError(validateSellForm({ ...VALID_FORM, amount: "abc" }), "amount")).toMatch(/must be a number/);
    expect(sellFieldError(validateSellForm({ ...VALID_FORM, amount: "100001" }), "amount")).toMatch(/must not exceed 100000/);
    expect(sellFieldError(validateSellForm({ ...VALID_FORM, description: "x".repeat(501) }), "description")).toMatch(/at most 500/);
    expect(sellFieldError(validateSellForm(VALID_FORM), "amount")).toBeNull();
  });
});

describe("sell form — request body + preview", () => {
  it("builds the server body: numbers parsed, currency normalised, empty reference omitted", () => {
    expect(
      buildOrderRequestBody({ description: " Logo pack ", amount: "1,200", currency: "usd", reference: "" }),
    ).toEqual({ description: "Logo pack", amount: 1200, currency: "USD" });
    expect(
      buildOrderRequestBody({ description: "Cable pack", amount: "59.5", currency: "eur", reference: " LP-SALE-001 " }),
    ).toEqual({ description: "Cable pack", amount: 59.5, currency: "EUR", reference: "LP-SALE-001" });
  });

  it("preview names the sale and its amount; invalid amounts are never guessed", () => {
    expect(sellPreviewSummary(VALID_FORM)).toBe("Logo pack · USD 75.00");
    expect(sellPreviewSummary(emptySellForm())).toBe("Untitled sale · no amount yet");
    expect(sellPreviewSummary({ ...VALID_FORM, amount: "abc" })).toBe("Logo pack · no amount yet");
    expect(sellPreviewSummary({ ...VALID_FORM, amount: "0" })).toBe("Logo pack · no amount yet");
  });

  it("the example sale validates and its body is accepted by the real server draft", () => {
    expect(validateSellForm(EXAMPLE_SELL_FORM).ok).toBe(true);
    const plan = draftOrderPlan(buildOrderRequestBody(EXAMPLE_SELL_FORM));
    expect(plan.status).toBe("pending_approval");
    expect(plan.source).toBe("api");
    expect(plan.steps[0]!.type).toBe("create_order");
    expect(plan.steps[0]!.paypalCall).toEqual({ method: "POST", path: "/v2/checkout/orders" });
    expect(plan.steps[0]!.payload).toMatchObject({
      description: EXAMPLE_SELL_FORM.description,
      amount: { currency_code: "USD", value: "75.00" },
    });
  });
});

describe("sell form — full loop through the gate", () => {
  it("a form-built draft refuses unapproved execution, then creates a payable order that captures", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    const plan = store.addPlan(draftOrderPlan(buildOrderRequestBody(EXAMPLE_SELL_FORM)));

    await expect(executePlan(store, client, plan.id)).rejects.toThrow(/approval/);
    expect(await client.listOrders()).toHaveLength(0);

    store.approvePlan(plan.id);
    const result = await executePlan(store, client, plan.id);
    expect(result.plan.status).toBe("completed");
    const orders = await client.listOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe("CREATED");

    // The created order's buyer view is payable with the mock link.
    const rows = buildOrderRows(orders);
    expect(rows[0]).toMatchObject({ checkoutState: "payable", checkoutIsMock: true });

    // Buyer-side capture closes the sell loop.
    const captured = await captureCheckoutOrder(client, store, orders[0]!.id);
    expect(captured.alreadyCaptured).toBe(false);
    expect(captured.order.status).toBe("COMPLETED");
    const txns = await client.listTransactions();
    expect(txns.map((t) => t.transaction_amount.value)).toContain("75.00");
  });
});
