import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RATE_LIMIT_WINDOW_MS,
  createRateLimiter,
  describeRateLimited,
} from "../src/lib/api";

const ROOT = join(__dirname, "..");
const T0 = 1_760_000_000_000;

/**
 * Rate-limit window config hygiene — the limiter's fixed window
 * honours a positive finite `windowMs` exactly, and falls back to
 * the default (`RATE_LIMIT_WINDOW_MS`, 60 s) for a non-positive or
 * non-finite one, mirroring the sandbox and LLM adapters' pinned
 * fallbacks for their timeout bounds. Until this fallback existed,
 * the raw value drove every window comparison: 0 or a negative
 * made `now - windowStart >= windowMs` true for every request, so
 * each request opened a fresh window and the flood brake silently
 * never engaged; NaN made the window never expire and the
 * Retry-After arithmetic NaN; Infinity made the window never
 * expire with an infinite Retry-After — one malformed config
 * value either disarmed the limiter or locked every client out
 * permanently, with no signal either way.
 */
describe("rate-limit window config hygiene", () => {
  it("pins the default window at 60 seconds", () => {
    expect(RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });

  it.each([
    ["zero", 0],
    ["negative", -30_000],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])(
    "falls back to the default window for a %s windowMs: the limiter reports and enforces 60 seconds",
    (_label, windowMs) => {
      const limiter = createRateLimiter(1, windowMs);
      expect(limiter.windowMs).toBe(RATE_LIMIT_WINDOW_MS);
      expect(limiter.check("a", T0)).toEqual({ allowed: true, retryAfterSeconds: 0 });
      expect(limiter.check("a", T0 + 30_000)).toEqual({
        allowed: false,
        retryAfterSeconds: 30,
      });
      expect(limiter.check("a", T0 + 59_999).allowed).toBe(false);
      expect(limiter.check("a", T0 + 60_000)).toEqual({
        allowed: true,
        retryAfterSeconds: 0,
      });
    },
  );

  it("a malformed window does not disarm the limiter: the second POST inside the default window is refused", () => {
    const limiter = createRateLimiter(1, 0);
    expect(describeRateLimited("/api/agent/plan", "POST", new Headers(), limiter, T0)).toBeNull();
    const described = describeRateLimited(
      "/api/agent/plan",
      "POST",
      new Headers(),
      limiter,
      T0 + 1_000,
    );
    expect(described).not.toBeNull();
    expect(described!.status).toBe(429);
    expect(described!.retryAfterSeconds).toBe(59);
    expect(described!.body.error).toContain("1 POST requests per 60 seconds");
  });

  it("the deliberate block-all limit (maxRequests 0) reports the fallback window, not the malformed one", () => {
    const limiter = createRateLimiter(0, Number.NaN);
    expect(limiter.windowMs).toBe(RATE_LIMIT_WINDOW_MS);
    expect(limiter.check("a", T0)).toEqual({ allowed: false, retryAfterSeconds: 60 });
    const described = describeRateLimited(
      "/api/agent/plan",
      "POST",
      new Headers(),
      limiter,
      T0,
    );
    expect(described!.retryAfterSeconds).toBe(60);
    expect(described!.body.error).toContain("per 60 seconds");
  });

  it("still honours a valid small windowMs exactly", () => {
    const limiter = createRateLimiter(1, 5_000);
    expect(limiter.windowMs).toBe(5_000);
    expect(limiter.check("a", T0).allowed).toBe(true);
    expect(limiter.check("a", T0 + 4_000)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    expect(limiter.check("a", T0 + 5_000)).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
  });

  it("is documented in the README", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(readme).toContain("rate-limit window");
    expect(readme).toContain("RATE_LIMIT_WINDOW_MS");
  });
});
