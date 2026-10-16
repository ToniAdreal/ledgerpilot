import { describe, expect, it } from "vitest";
import { BriefParseError, parseBrief, parseDueDate } from "../src/lib/agent/parser";

// Reference instant used across the parser suites: Saturday 2026-10-10 UTC.
const NOW = new Date("2026-10-10T00:00:00Z");

describe("parser due dates — impossible ISO dates are refused, not carried into a plan", () => {
  it.each(["2026-02-30", "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-00"])(
    "parseDueDate(%s) throws a BriefParseError naming the real-calendar rule",
    (text) => {
      expect(() => parseDueDate(text, NOW)).toThrow(BriefParseError);
      expect(() => parseDueDate(text, NOW)).toThrow(/'dueDate' must be a real calendar date \(yyyy-mm-dd\)/);
    },
  );

  it("accepts a real leap day and ordinary ISO dates unchanged", () => {
    expect(parseDueDate("2028-02-29", NOW)).toBe("2028-02-29");
    expect(parseDueDate("2026-11-01", NOW)).toBe("2026-11-01");
  });

  it("a brief naming an impossible due date produces no plan at all", () => {
    expect(() => parseBrief("Invoice Ana $450 for logo work, due 2026-02-30", { now: NOW })).toThrow(
      BriefParseError,
    );
    expect(() => parseBrief("Invoice Ana $450 for logo work, due 2026-02-30", { now: NOW })).toThrow(
      /real calendar date/,
    );
  });

  it("a brief with a real due date still plans with that exact date", () => {
    const plan = parseBrief("Invoice Ana $450 for logo work, due 2026-11-01", { now: NOW });
    expect(plan.steps[0]?.payload.dueDate).toBe("2026-11-01");
  });
});

describe("parser due dates — out-of-range relative offsets are refused, not a RangeError or a corrupt string", () => {
  it.each(["in 999999999999 days", "in 99999999 days", "in 9999999 days"])(
    "parseDueDate(%s) throws a BriefParseError, never a RangeError",
    (text) => {
      let caught: unknown;
      try {
        parseDueDate(text, NOW);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BriefParseError);
      expect(caught).not.toBeInstanceOf(RangeError);
      expect((caught as Error).message).toMatch(/due date/i);
    },
  );

  it("a brief with an out-of-range relative due date produces no plan", () => {
    expect(() =>
      parseBrief("Invoice Ana $450 for logo work, due in 999999999999 days", { now: NOW }),
    ).toThrow(BriefParseError);
  });

  it("ordinary relative forms are unchanged", () => {
    expect(parseDueDate("Friday", NOW)).toBe("2026-10-16");
    expect(parseDueDate("in 3 days", NOW)).toBe("2026-10-13");
    expect(parseDueDate("in 365 days", NOW)).toBe("2027-10-10");
    expect(parseDueDate("tomorrow", NOW)).toBe("2026-10-11");
    expect(parseDueDate("today", NOW)).toBe("2026-10-10");
    expect(parseDueDate("whenever", NOW)).toBeUndefined();
  });
});
