import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RATE_LIMIT_MAX_POSTS,
  createRateLimiter,
  describeRateLimited,
} from "../src/lib/api";

const ROOT = join(__dirname, "..");
const T0 = 1_760_000_000_000;

/**
 * Rate-limit limit config hygiene — the limiter's per-window
 * limit honours a positive integer `maxRequests` exactly, and
 * sanitises a malformed one instead of driving the count
 * comparison raw, mirroring the window fallback in
 * `api-rate-limit-window-config.test.ts` and the sandbox and
 * LLM adapters' pinned fallbacks for their timeout bounds.
 * Until this sanitisation existed, the raw value drove every
 * comparison: NaN made `count < maxRequests` false from the
 * second request on, so the limiter silently became a
 * near-block-all whose 429 message reported "NaN POST
 * requests"; Infinity made the comparison always true, so the
 * flood brake silently never engaged; a fractional limit such
 * as 2.5 admitted 3 requests while its message reported 2.5 —
 * a count that can never be the enforced limit, because a
 * request count is an integer.
 */
describe("rate-limit limit config hygiene", () => {
  it("pins the default limit at 120 POST requests", () => {
    expect(RATE_LIMIT_MAX_POSTS).toBe(120);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])(
    "falls back to the default limit for a %s maxRequests: the limiter reports and enforces 120",
    (_label, maxRequests) => {
      const limiter = createRateLimiter(maxRequests, 60_000);
      expect(limiter.maxRequests).toBe(RATE_LIMIT_MAX_POSTS);
      for (let i = 0; i < RATE_LIMIT_MAX_POSTS; i++) {
        expect(limiter.check("a", T0)).toEqual({ allowed: true, retryAfterSeconds: 0 });
      }
      const verdict = limiter.check("a", T0);
      expect(verdict.allowed).toBe(false);
      expect(verdict.retryAfterSeconds).toBe(60);
    },
  );

  it("a NaN limit does not become a near-block-all: the second POST inside the window is allowed", () => {
    const limiter = createRateLimiter(Number.NaN, 60_000);
    expect(describeRateLimited("/api/agent/plan", "POST", new Headers(), limiter, T0)).toBeNull();
    expect(
      describeRateLimited("/api/agent/plan", "POST", new Headers(), limiter, T0 + 1_000),
    ).toBeNull();
  });

  it("an Infinity limit does not disarm the limiter: the 121st POST inside the window is refused, naming 120", () => {
    const limiter = createRateLimiter(Number.POSITIVE_INFINITY, 60_000);
    for (let i = 0; i < RATE_LIMIT_MAX_POSTS; i++) {
      expect(describeRateLimited("/api/agent/plan", "POST", new Headers(), limiter, T0)).toBeNull();
    }
    const described = describeRateLimited(
      "/api/agent/plan",
      "POST",
      new Headers(),
      limiter,
      T0,
    );
    expect(described).not.toBeNull();
    expect(described!.status).toBe(429);
    expect(described!.body.error).toContain("120 POST requests per 60 seconds");
    expect(described!.body.error).not.toContain("Infinity");
    expect(described!.body.error).not.toContain("NaN");
  });

  it("a fractional positive limit is floored to the whole requests it admits, and reports that integer", () => {
    const limiter = createRateLimiter(2.9, 60_000);
    expect(limiter.maxRequests).toBe(2);
    expect(limiter.check("a", T0).allowed).toBe(true);
    expect(limiter.check("a", T0).allowed).toBe(true);
    expect(limiter.check("a", T0).allowed).toBe(false);
    const describing = createRateLimiter(2.9, 60_000);
    expect(describeRateLimited("/api/agent/plan", "POST", new Headers(), describing, T0)).toBeNull();
    expect(describeRateLimited("/api/agent/plan", "POST", new Headers(), describing, T0)).toBeNull();
    const described = describeRateLimited(
      "/api/agent/plan",
      "POST",
      new Headers(),
      describing,
      T0,
    );
    expect(described!.body.error).toContain("2 POST requests per 60 seconds");
  });

  it("a sub-1 fractional limit floors to the deliberate block-all case", () => {
    const limiter = createRateLimiter(0.5, 60_000);
    expect(limiter.maxRequests).toBe(0);
    expect(limiter.check("a", T0)).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
  ])(
    "the deliberate block-all limit (%s) is unchanged: it reports its value and refuses the first request",
    (_label, maxRequests) => {
      const limiter = createRateLimiter(maxRequests, 60_000);
      expect(limiter.maxRequests).toBe(maxRequests);
      expect(limiter.check("a", T0)).toEqual({ allowed: false, retryAfterSeconds: 60 });
    },
  );

  it("still honours a valid integer limit exactly", () => {
    const limiter = createRateLimiter(3, 60_000);
    expect(limiter.maxRequests).toBe(3);
    expect(limiter.check("a", T0).allowed).toBe(true);
    expect(limiter.check("a", T0).allowed).toBe(true);
    expect(limiter.check("a", T0).allowed).toBe(true);
    expect(limiter.check("a", T0).allowed).toBe(false);
    expect(limiter.check("a", T0 + 60_000).allowed).toBe(true);
  });

  it("is documented in the README", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(readme).toContain("rate-limit limit");
    expect(readme).toContain("RATE_LIMIT_MAX_POSTS");
  });
});
