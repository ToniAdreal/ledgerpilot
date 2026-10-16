import { describe, expect, it } from "vitest";
import { BriefParseError, parseBrief } from "../src/lib/agent/parser";

// Reference instant used across the parser suites: Saturday 2026-10-10 UTC.
const NOW = new Date("2026-10-10T00:00:00Z");

describe("parser amounts — non-positive amounts are refused, not carried into a plan", () => {
  it.each([
    "Invoice Ana $0 for logo work",
    "Invoice Ana $0.00 for logo work",
    "Invoice Ana $,,, for logo work",
    "Pay $0 to Marco",
    "Pay Marco $0",
    "Sell a logo pack for $0",
  ])("parseBrief(%s) throws a BriefParseError naming the greater-than-zero rule", (brief) => {
    expect(() => parseBrief(brief, { now: NOW })).toThrow(BriefParseError);
    expect(() => parseBrief(brief, { now: NOW })).toThrow(/'amount' must be greater than zero/);
  });
});

describe("parser amounts — amounts over the 100,000 cap are refused, not carried into a plan", () => {
  it.each([
    "Invoice Ana $100,000.01 for logo work",
    "Invoice Ana $100001 for logo work",
    "Invoice Ana $200,000 for logo work",
    "Pay $200,000 to Marco",
    "Pay Marco $150,000",
    "Sell a logo pack for $100,001",
  ])("parseBrief(%s) throws a BriefParseError naming the cap", (brief) => {
    expect(() => parseBrief(brief, { now: NOW })).toThrow(BriefParseError);
    expect(() => parseBrief(brief, { now: NOW })).toThrow(/'amount' must not exceed 100000/);
  });

  it("a huge amount is refused as a BriefParseError, never carried as an exponential money string", () => {
    let caught: unknown;
    try {
      parseBrief("Invoice Ana $99999999999999999999999 for logo work", { now: NOW });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BriefParseError);
    expect((caught as Error).message).toMatch(/must not exceed 100000/);
  });

  it("a valid invoice with an over-cap gated payout produces no plan at all", () => {
    expect(() =>
      parseBrief(
        "Invoice Ana $450 for brand work, due Friday. When it lands, pay $200,000 to my contractor Marco.",
        { now: NOW },
      ),
    ).toThrow(BriefParseError);
  });
});

describe("parser amounts — valid amounts are unchanged", () => {
  it("accepts the boundary amount and the smallest positive amount exactly", () => {
    const atCap = parseBrief("Invoice Ana $100,000 for logo work", { now: NOW });
    const step = atCap.steps[0] as unknown as { payload: { items: { unit_amount: { value: string } }[] } };
    expect(step.payload.items[0]?.unit_amount.value).toBe("100000.00");
    const cent = parseBrief("Pay Marco $0.01", { now: NOW });
    const payout = cent.steps[0] as unknown as { payload: { amount: { value: string } } };
    expect(payout.payload.amount.value).toBe("0.01");
  });

  it("ordinary comma-grouped and decimal amounts format as before", () => {
    const plan = parseBrief("Invoice Ana $1,250.50 for website redesign, due in 5 days", { now: NOW });
    const step = plan.steps[0] as unknown as { payload: { items: { unit_amount: { value: string } }[] } };
    expect(step.payload.items[0]?.unit_amount.value).toBe("1250.50");
    const sell = parseBrief("Sell a studio cable pack for $59", { now: NOW });
    const order = sell.steps[0] as unknown as { payload: { amount: { value: string } } };
    expect(order.payload.amount.value).toBe("59.00");
  });
});
