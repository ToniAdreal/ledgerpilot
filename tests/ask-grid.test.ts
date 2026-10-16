import { describe, expect, it } from "vitest";
import {
  EXAMPLE_ASKS,
  parseAskQuery,
  validateAskFilterModels,
  type GridFilterModel,
} from "../src/lib/ask";

/** Saturday Oct 10, 2026 (UTC) — the same reference date as the other suites. */
const NOW = new Date("2026-10-10T12:00:00Z");

function invoices(result: ReturnType<typeof parseAskQuery>): GridFilterModel {
  const model = result.models.invoices;
  expect(model, "expected an invoices filter model").toBeDefined();
  return model!;
}

describe("parseAskQuery — status + amount (the CONCEPT.md example)", () => {
  it("compiles “show unpaid invoices over $200 from this month” into a validated model", () => {
    const result = parseAskQuery("show unpaid invoices over $200 from this month", { now: NOW });
    expect(result.targets).toEqual(["invoices"]);
    const model = invoices(result);
    expect(model.status).toEqual({
      filterType: "text",
      operator: "OR",
      conditions: [
        { filterType: "text", type: "equals", filter: "SENT" },
        { filterType: "text", type: "equals", filter: "SCHEDULED" },
        { filterType: "text", type: "equals", filter: "PARTIALLY_PAID" },
      ],
    });
    expect(model.amountValue).toEqual({ filterType: "number", type: "greaterThan", filter: 200 });
    expect(model.currency).toEqual({ filterType: "text", type: "equals", filter: "USD" });
    expect(model.dueDate).toEqual({
      filterType: "date",
      type: "inRange",
      dateFrom: "2026-10-01",
      dateTo: "2026-10-31",
    });
    expect(validateAskFilterModels(result.models)).toEqual([]);
    expect(result.summary).toContain("Invoices");
  });

  it("maps “paid” per grid: PAID invoices, COMPLETED orders, SUCCESS payouts", () => {
    const result = parseAskQuery("show paid", { now: NOW });
    expect(result.models.invoices!.status).toEqual({
      filterType: "text",
      operator: "OR",
      conditions: [
        { filterType: "text", type: "equals", filter: "PAID" },
        { filterType: "text", type: "equals", filter: "MARKED_AS_PAID" },
      ],
    });
    expect(result.models.orders!.status).toEqual({ filterType: "text", type: "equals", filter: "COMPLETED" });
    expect(result.models.payouts!.status).toEqual({ filterType: "text", type: "equals", filter: "SUCCESS" });
    expect(result.models.activity).toBeUndefined();
  });

  it("“partially paid” wins over “paid” (longest phrase first)", () => {
    const result = parseAskQuery("show partially paid invoices", { now: NOW });
    expect(invoices(result).status).toEqual({ filterType: "text", type: "equals", filter: "PARTIALLY_PAID" });
  });

  it("“everything still unpaid” (the demo storyboard query) filters every money grid", () => {
    const result = parseAskQuery("Show everything still unpaid", { now: NOW });
    expect(result.targets).toEqual(["invoices", "orders", "payouts"]);
    expect(result.models.orders!.status).toEqual({
      filterType: "text",
      operator: "OR",
      conditions: [
        { filterType: "text", type: "equals", filter: "CREATED" },
        { filterType: "text", type: "equals", filter: "SAVED" },
        { filterType: "text", type: "equals", filter: "APPROVED" },
      ],
    });
    expect(validateAskFilterModels(result.models)).toEqual([]);
  });
});

describe("parseAskQuery — overdue", () => {
  it("overdue = open status + due date before the reference date (the read model's definition)", () => {
    const result = parseAskQuery("Show overdue invoices", { now: NOW });
    const model = invoices(result);
    expect(model.dueDate).toEqual({ filterType: "date", type: "lessThan", dateFrom: "2026-10-10" });
    expect(model.status).toMatchObject({ operator: "OR" });
    expect(result.summary).toContain("overdue");
  });

  it("overdue on a non-invoice grid is a note, not a silent filter", () => {
    const result = parseAskQuery("show overdue invoices and failed payouts", { now: NOW });
    expect(result.models.payouts!.status).toEqual({ filterType: "text", type: "equals", filter: "FAILED" });
    expect(result.notes.join(" ")).toContain("Overdue");
  });
});

describe("parseAskQuery — amounts", () => {
  it("supports under / at least / exactly / between / or-more forms", () => {
    expect(invoices(parseAskQuery("invoices under €80", { now: NOW })).amountValue).toEqual({
      filterType: "number",
      type: "lessThan",
      filter: 80,
    });
    expect(invoices(parseAskQuery("invoices under €80", { now: NOW })).currency).toEqual({
      filterType: "text",
      type: "equals",
      filter: "EUR",
    });
    expect(invoices(parseAskQuery("invoices at least $1,000", { now: NOW })).amountValue).toEqual({
      filterType: "number",
      type: "greaterThanOrEqual",
      filter: 1000,
    });
    expect(invoices(parseAskQuery("invoices exactly £45.50", { now: NOW })).amountValue).toEqual({
      filterType: "number",
      type: "equals",
      filter: 45.5,
    });
    expect(invoices(parseAskQuery("invoices between $50 and $150", { now: NOW })).amountValue).toEqual({
      filterType: "number",
      type: "inRange",
      filter: 50,
      filterTo: 150,
    });
    expect(invoices(parseAskQuery("invoices $200 or more", { now: NOW })).amountValue).toEqual({
      filterType: "number",
      type: "greaterThanOrEqual",
      filter: 200,
    });
  });

  it("between normalizes a reversed range", () => {
    expect(invoices(parseAskQuery("invoices between $150 and $50", { now: NOW })).amountValue).toEqual({
      filterType: "number",
      type: "inRange",
      filter: 50,
      filterTo: 150,
    });
  });
});

describe("parseAskQuery — amount hygiene (digit-less and overflowing amounts refused)", () => {
  it("refuses a commas-only amount instead of compiling an over-0.00 filter", () => {
    expect(() => parseAskQuery("show invoices over ,,,", { now: NOW })).toThrowError(/has no digits/);
    expect(() => parseAskQuery("show invoices over ,,,", { now: NOW })).not.toThrowError(/Internal validation/);
  });

  it("refuses a commas-only amount in the or-more and between forms", () => {
    expect(() => parseAskQuery("invoices $, or more", { now: NOW })).toThrowError(/has no digits/);
    expect(() => parseAskQuery("invoices between $, and $150", { now: NOW })).toThrowError(/has no digits/);
    expect(() => parseAskQuery("invoices between $50 and ,,,", { now: NOW })).toThrowError(/has no digits/);
  });

  it("a very large but finite amount still compiles and validates (a filter carries no money cap)", () => {
    // The 300-character query cap keeps every reachable digit string
    // finite, so the conversion point's non-finite guard is defence
    // in depth; what must hold today is that a large finite filter —
    // far above any plan-amount cap — is honoured, not refused.
    const result = parseAskQuery("invoices over $999999999999", { now: NOW });
    expect(invoices(result).amountValue).toEqual({
      filterType: "number",
      type: "greaterThan",
      filter: 999999999999,
    });
    expect(validateAskFilterModels(result.models)).toEqual([]);
  });

  it("ordinary comma-grouped and decimal amounts are unchanged", () => {
    expect(invoices(parseAskQuery("invoices over $1,200.50", { now: NOW })).amountValue).toEqual({
      filterType: "number",
      type: "greaterThan",
      filter: 1200.5,
    });
    expect(invoices(parseAskQuery("invoices over $0.01", { now: NOW })).amountValue).toEqual({
      filterType: "number",
      type: "greaterThan",
      filter: 0.01,
    });
  });
});

describe("parseAskQuery — people, keywords, kinds, dates", () => {
  it("recipient: “payouts to Marco” filters recipientName contains Marco", () => {
    const result = parseAskQuery("Show payouts to Marco", { now: NOW });
    expect(result.targets).toEqual(["payouts"]);
    expect(result.models.payouts!.recipientName).toEqual({
      filterType: "text",
      type: "contains",
      filter: "Marco",
    });
  });

  it("possessive recipient: “Ana's invoices”", () => {
    const result = parseAskQuery("Show Ana's invoices", { now: NOW });
    expect(invoices(result).recipientName).toEqual({ filterType: "text", type: "contains", filter: "Ana" });
  });

  it("“from this month” is a date, not a recipient named This", () => {
    const result = parseAskQuery("show unpaid invoices over $200 from this month", { now: NOW });
    expect(invoices(result).recipientName).toBeUndefined();
  });

  it("quoted keyword lands on each grid's primary text field", () => {
    const result = parseAskQuery('show activity about "logo work"', { now: NOW });
    expect(result.models.activity!.summary).toEqual({
      filterType: "text",
      type: "contains",
      filter: "logo work",
    });
  });

  it("webhook events filter the Activity grid by kind", () => {
    const result = parseAskQuery("Show webhook events", { now: NOW });
    expect(result.targets).toEqual(["activity"]);
    expect(result.models.activity!.kind).toEqual({ filterType: "text", type: "equals", filter: "webhook" });
  });

  it("today and last month produce exact date ranges from the injected reference date", () => {
    expect(invoices(parseAskQuery("invoices due today", { now: NOW })).dueDate).toEqual({
      filterType: "date",
      type: "equals",
      dateFrom: "2026-10-10",
    });
    expect(invoices(parseAskQuery("invoices due last month", { now: NOW })).dueDate).toEqual({
      filterType: "date",
      type: "inRange",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
    });
  });

  it("a date condition on Orders (no date column) is noted and skipped, other grids still filter", () => {
    const result = parseAskQuery("show paid this month", { now: NOW });
    expect(result.models.orders).toBeDefined();
    expect(result.models.orders!.dueDate).toBeUndefined();
    expect(result.notes.join(" ")).toContain("no date");
    expect(invoices(result).dueDate).toMatchObject({ type: "inRange", dateFrom: "2026-10-01" });
  });
});

describe("parseAskQuery — rejection paths", () => {
  it("rejects an empty query", () => {
    expect(() => parseAskQuery("   ", { now: NOW })).toThrowError(/Ask a question first/);
  });

  it("rejects a query with no recognizable filter, with guidance", () => {
    expect(() => parseAskQuery("show me the money", { now: NOW })).toThrowError(/No filter found/);
  });

  it("rejects a filter that cannot apply to the named grid", () => {
    expect(() => parseAskQuery("show webhook events over $200", { now: NOW })).not.toThrowError(/does not apply/);
    // Amount alone on the Activity grid: no amount column, no kind — nothing applies.
    expect(() => parseAskQuery("show activity over $200", { now: NOW })).toThrowError(/does not apply/);
  });

  it("rejects over-long queries", () => {
    expect(() => parseAskQuery(`show unpaid invoices ${"x".repeat(300)}`, { now: NOW })).toThrowError(/too long/);
  });
});

describe("validateAskFilterModels", () => {
  it("accepts every model the parser emits for the example asks", () => {
    for (const ex of EXAMPLE_ASKS) {
      const result = parseAskQuery(ex.query, { now: NOW });
      expect(validateAskFilterModels(result.models), ex.label).toEqual([]);
      expect(result.targets.length, ex.label).toBeGreaterThanOrEqual(1);
    }
  });

  it("rejects an unknown column", () => {
    const problems = validateAskFilterModels({
      invoices: { secretField: { filterType: "text", type: "equals", filter: "x" } },
    });
    expect(problems.join(" ")).toContain("unknown column");
  });

  it("rejects a filterType that does not match the column", () => {
    const problems = validateAskFilterModels({
      invoices: { amountValue: { filterType: "text", type: "equals", filter: "200" } },
    });
    expect(problems.join(" ")).toContain('filterType must be "number"');
  });

  it("rejects a non-whitelisted comparison type and a non-finite amount", () => {
    expect(
      validateAskFilterModels({
        invoices: { status: { filterType: "text", type: "regex", filter: ".*" } },
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateAskFilterModels({
        payouts: { amountValue: { filterType: "number", type: "greaterThan", filter: Number.NaN } },
      }).length,
    ).toBeGreaterThan(0);
  });

  it("rejects an unknown grid and a combined model with a bad operator", () => {
    expect(validateAskFilterModels({ orders2: {} } as never).join(" ")).toContain("unknown grid");
    const problems = validateAskFilterModels({
      invoices: {
        status: {
          filterType: "text",
          operator: "XOR",
          conditions: [{ filterType: "text", type: "equals", filter: "PAID" }],
        } as never,
      },
    });
    expect(problems.join(" ")).toContain("operator");
  });

  it("rejects an inRange number model without filterTo and a date model without dateFrom", () => {
    expect(
      validateAskFilterModels({
        invoices: { amountValue: { filterType: "number", type: "inRange", filter: 10 } },
      }).join(" "),
    ).toContain("filterTo");
    expect(
      validateAskFilterModels({
        invoices: { dueDate: { filterType: "date", type: "equals" } },
      }).join(" "),
    ).toContain("dateFrom");
  });
});

describe("EXAMPLE_ASKS", () => {
  it("every example parses, validates, and targets at least one grid — chips never offer a dead end", () => {
    expect(EXAMPLE_ASKS.length).toBeGreaterThanOrEqual(5);
    for (const ex of EXAMPLE_ASKS) {
      const result = parseAskQuery(ex.query, { now: NOW });
      expect(result.explanations.length, ex.label).toBeGreaterThanOrEqual(1);
    }
  });
});
