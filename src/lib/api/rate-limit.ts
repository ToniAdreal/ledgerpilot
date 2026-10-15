/**
 * Rate limit — the JSON 429 for a client POSTing faster than the
 * hosted demo can be expected to absorb.
 *
 * The request-body size limit (`src/lib/api/body.ts`) bounds what
 * one request can cost: 128 KiB, measured before parsing. Until
 * this module existed, nothing bounded how *many* requests a
 * client could send: every POST under `/api/` does real work —
 * drafting plans, seeding or resetting the demo, recording
 * payments, delivering webhooks, and (in sandbox mode) calling
 * PayPal — and the hosted demo deliberately ships with no
 * authentication layer, so a tight loop from one client could
 * flood the ledger, the audit log, and the sandbox app at no cost
 * to itself. The size limit's own rationale named this surface
 * ("a real denial-of-service surface"); this module is its
 * rate half.
 *
 * The fix is middleware (`src/middleware.ts`) over this module,
 * as the third guard, after the method guard (405) and the
 * negotiation guard (406): a wrong-method or non-negotiating
 * request is answered for what it is before it counts against
 * anyone's allowance.
 *
 * The limit, in code:
 *  - **POST requests only.** Mutating requests are the flood
 *    surface; reads (console grids, the readiness report, the
 *    OpenAPI document) are cheap projections and are never
 *    counted, so a judge reloading the console or a host probing
 *    `GET /api/health` can never trip the limit.
 *  - **120 POSTs per 60-second fixed window per client key** —
 *    far above any legitimate use (the shipped smoke script's
 *    full Judge Mode loop is 5 POSTs; a judge clicking through
 *    the demo sends a handful per minute), low enough that a
 *    flood loop is braked within its first seconds.
 *  - **Refusals are the shared shape plus `Retry-After`**: a
 *    JSON 429 in the API's one `{ error }` shape naming the
 *    limit, with a `Retry-After` header carrying the seconds
 *    until the client's window resets. A refused request does
 *    not consume further allowance and never reaches a route,
 *    the runtime, or PayPal.
 *  - **The webhook listener is NOT exempt.** PayPal retries
 *    deliveries that are answered with an error status, and
 *    verified events are processed exactly once by event id, so
 *    a 429 during a genuine burst delays events rather than
 *    dropping them — unlike the 406 exemption, where the header
 *    itself was never PayPal's negotiation to begin with.
 *
 * Window config hygiene: a non-positive or non-finite `windowMs`
 * passed to `createRateLimiter` falls back to the default
 * (`RATE_LIMIT_WINDOW_MS`) instead of driving the window
 * comparisons raw — 0 or a negative would make every request
 * open a fresh window, so the flood brake would silently never
 * engage; NaN would make the window never expire and the
 * Retry-After arithmetic NaN; Infinity would make the window
 * never expire at all. One malformed config value either
 * disarmed the limiter or locked every client out permanently,
 * with no signal either way. A valid window is honoured exactly.
 * This mirrors the sandbox and LLM adapters' pinned fallbacks
 * for their timeout bounds. (The deliberate block-all case is
 * separate and unchanged: `maxRequests <= 0` refuses every
 * request, with its Retry-After computed from the sanitised
 * window.)
 *
 * Client identity, honestly: the key is the first
 * `x-forwarded-for` entry when a proxy supplies one, else
 * `x-real-ip`, else a single shared "direct" bucket. On an
 * instance exposed without a trusted proxy those headers can be
 * forged, so this is a flood brake, not an identity or
 * authentication control — the same warning SECURITY.md carries
 * for the API as a whole. State is per-process in-memory (one
 * server process per instance, like the ledger's snapshot
 * store); a multi-instance host needs an external limiter,
 * which is a deployment decision, not this module's claim.
 */

import { NextResponse } from "next/server";

/** Maximum POST requests accepted per client key per window. */
export const RATE_LIMIT_MAX_POSTS = 120;

/** Length of the fixed rate-limit window, in milliseconds. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** Length of the fixed rate-limit window, in seconds (the unit the message and `Retry-After` speak). */
export const RATE_LIMIT_WINDOW_SECONDS = RATE_LIMIT_WINDOW_MS / 1000;

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the current window resets; 0 when the request is allowed. */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** The limit this limiter enforces (requests per window). */
  readonly maxRequests: number;
  /** The window length this limiter enforces, in milliseconds. */
  readonly windowMs: number;
  /** Record one request for `key` at time `now` (ms) and answer whether it is within the limit. */
  check(key: string, now: number): RateLimitVerdict;
}

interface WindowState {
  windowStart: number;
  count: number;
}

/**
 * A fixed-window rate limiter. The window is anchored at the
 * first request after the previous window expired; a request
 * exactly at the limit is allowed, the next one is refused.
 * Expired keys are swept lazily when the map grows large, so a
 * flood of distinct keys cannot grow it without bound either.
 */
export function createRateLimiter(
  maxRequests: number = RATE_LIMIT_MAX_POSTS,
  windowMs: number = RATE_LIMIT_WINDOW_MS,
): RateLimiter {
  // A malformed window must not drive the comparisons raw: a
  // non-positive or non-finite value falls back to the default
  // window (see the header's window-config-hygiene note). The
  // limiter reports and enforces this effective window, so the
  // 429 message and Retry-After always name a real window.
  const effectiveWindowMs =
    Number.isFinite(windowMs) && windowMs > 0 ? windowMs : RATE_LIMIT_WINDOW_MS;
  const windows = new Map<string, WindowState>();
  return {
    maxRequests,
    windowMs: effectiveWindowMs,
    check(key: string, now: number): RateLimitVerdict {
      if (maxRequests <= 0) {
        return { allowed: false, retryAfterSeconds: Math.ceil(effectiveWindowMs / 1000) };
      }
      if (windows.size > 4096) {
        for (const [k, state] of windows) {
          if (now - state.windowStart >= effectiveWindowMs) windows.delete(k);
        }
      }
      const state = windows.get(key);
      if (!state || now - state.windowStart >= effectiveWindowMs) {
        windows.set(key, { windowStart: now, count: 1 });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (state.count < maxRequests) {
        state.count += 1;
        return { allowed: true, retryAfterSeconds: 0 };
      }
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((state.windowStart + effectiveWindowMs - now) / 1000),
      );
      return { allowed: false, retryAfterSeconds };
    },
  };
}

/** The process-wide limiter the middleware consults. */
export const apiPostRateLimiter: RateLimiter = createRateLimiter();

/**
 * The client key for a request: the first `x-forwarded-for`
 * entry when present, else `x-real-ip`, else the shared
 * "direct" bucket. See the header for the honesty note —
 * these headers are a flood-brake key, not an identity.
 */
export function rateLimitKeyFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "direct";
}

export interface RateLimitedDescription {
  status: 429;
  retryAfterSeconds: number;
  body: { error: string };
}

/**
 * Pure-but-stateful description of the 429 for a request that
 * exceeds the POST limit, or null when the request passes
 * through: the method is not POST (reads are never counted), or
 * the client's window still has allowance. Only a POST that
 * reaches this guard consumes allowance. `limiter` and `now`
 * are injectable so tests never touch the process-wide state.
 */
export function describeRateLimited(
  pathname: string,
  method: string,
  headers: Headers,
  limiter: RateLimiter = apiPostRateLimiter,
  now: number = Date.now(),
): RateLimitedDescription | null {
  if (method.toUpperCase() !== "POST") return null;
  const verdict = limiter.check(rateLimitKeyFromHeaders(headers), now);
  if (verdict.allowed) return null;
  return {
    status: 429,
    retryAfterSeconds: verdict.retryAfterSeconds,
    body: {
      error: `Too Many Requests — ${pathname} is one of this API's POST routes, limited to ${limiter.maxRequests} POST requests per ${limiter.windowMs / 1000} seconds per client. Retry after ${verdict.retryAfterSeconds} seconds. See GET /api/openapi for the documented routes.`,
    },
  };
}

/** The 429 JSON response (with its `Retry-After` header), or null when the request passes through. */
export function rateLimitResponse(
  pathname: string,
  method: string,
  headers: Headers,
  limiter: RateLimiter = apiPostRateLimiter,
  now: number = Date.now(),
): NextResponse | null {
  const described = describeRateLimited(pathname, method, headers, limiter, now);
  if (!described) return null;
  const response = NextResponse.json(described.body, { status: described.status });
  response.headers.set("Retry-After", String(described.retryAfterSeconds));
  return response;
}
