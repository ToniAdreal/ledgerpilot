/**
 * Not acceptable — the JSON 406 for an `Accept` header that excludes
 * the only representation this API can return.
 *
 * Every route under `/api/` answers `application/json` and nothing
 * else, but until this module existed the API ignored the request's
 * `Accept` header entirely: a client that declared it accepts only
 * `text/html` (or that explicitly refused JSON with
 * `application/json;q=0`) was handed JSON anyway — a response its own
 * declared preferences said it cannot use, and behaviour no
 * documentation promised. The media-type family is now symmetric:
 * the request body's declared type is enforced (415, in
 * `src/lib/api/body.ts`) and the response's declared types are
 * enforced here (406).
 *
 * The fix is middleware (`src/middleware.ts`) over this module, in
 * the same place and discipline as the JSON 405: the method guard
 * runs first (a wrong-method call is a 405 whatever the client
 * accepts), then this negotiation check. The module builds no agent
 * runtime, so a non-negotiating client gets its 406 even on a
 * misconfigured sandbox instance.
 *
 * The check, in code:
 *  - A missing or empty `Accept` header accepts everything (the
 *    historic behaviour) — most API clients send none, or `* /*`.
 *  - Media ranges are matched by specificity, per HTTP semantics:
 *    an exact `application/json` range governs over `application/*`,
 *    which governs over `* /*`; within one specificity the highest
 *    `q` wins; the representation is acceptable only when the
 *    governing range's `q` is greater than 0. Parameters other than
 *    `q` do not change the match (this API has one JSON flavour).
 *  - A suffix range such as `application/vnd.example+json` does NOT
 *    accept `application/json` — Accept ranges are exact types or
 *    wildcards, so naming a different `+json` type does not claim
 *    this API's plain JSON.
 *
 * Two deliberate exemptions, both documented here and test-pinned:
 *  - `OPTIONS` passes through untouched — the framework answers it
 *    itself, and a capability probe is not a representation request.
 *  - `POST /api/paypal/webhooks` is never refused. Its sender is
 *    PayPal, a machine peer delivering an event, not a client
 *    negotiating a representation of this API's resources; the
 *    response is an acknowledgement, and refusing a delivery over
 *    PayPal's choice of `Accept` header would drop real events. The
 *    OpenAPI document mirrors the exemption: the shared 406 is
 *    appended to every operation except `receivePayPalWebhook`.
 *
 * The message names the requested path (the URL path only — never a
 * query string, header value, or credential) and the one media type
 * the API returns.
 */

import { NextResponse } from "next/server";

/** The path whose machine-peer sender is exempt from negotiation (see header). */
export const NEGOTIATION_EXEMPT_PATHS: readonly string[] = ["/api/paypal/webhooks"];

export interface NotAcceptableDescription {
  status: 406;
  body: { error: string };
}

interface MediaRange {
  type: string;
  subtype: string;
  q: number;
}

/** Parse an `Accept` header value into media ranges (unparseable entries are skipped). */
function parseAcceptHeader(accept: string): MediaRange[] {
  const ranges: MediaRange[] = [];
  for (const part of accept.split(",")) {
    const [mediaType, ...params] = part.split(";");
    const [type, subtype] = (mediaType ?? "").trim().toLowerCase().split("/");
    if (!type || !subtype) continue;
    let q = 1;
    for (const param of params) {
      const [name, value] = param.split("=").map((s) => s.trim().toLowerCase());
      if (name === "q") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) q = Math.min(1, Math.max(0, parsed));
      }
    }
    ranges.push({ type, subtype, q });
  }
  return ranges;
}

/** How specifically a range matches `application/json`: 3 exact, 2 type wildcard, 1 full wildcard, 0 no match. */
function matchSpecificity(range: MediaRange): number {
  if (range.type === "application" && range.subtype === "json") return 3;
  if (range.type === "application" && range.subtype === "*") return 2;
  if (range.type === "*" && range.subtype === "*") return 1;
  return 0;
}

/**
 * Pure check: can a client sending this `Accept` header accept this
 * API's one representation, `application/json`? A missing/empty
 * header accepts everything; otherwise the most specific matching
 * range governs (highest `q` within that specificity) and must
 * allow the representation (`q` > 0).
 */
export function isJsonAcceptable(accept: string | null): boolean {
  if (accept === null) return true;
  const ranges = parseAcceptHeader(accept);
  if (ranges.length === 0) return true;
  let bestSpecificity = 0;
  let bestQ = 0;
  for (const range of ranges) {
    const specificity = matchSpecificity(range);
    if (specificity === 0) continue;
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity;
      bestQ = range.q;
    } else if (specificity === bestSpecificity) {
      bestQ = Math.max(bestQ, range.q);
    }
  }
  if (bestSpecificity === 0) return false;
  return bestQ > 0;
}

/**
 * Pure description of the 406 for a request whose `Accept` header
 * excludes JSON, or null when the request passes through: the
 * header accepts JSON (or declares nothing), the method is OPTIONS,
 * or the path is the exempt webhook listener.
 */
export function describeNotAcceptable(
  pathname: string,
  method: string,
  accept: string | null,
): NotAcceptableDescription | null {
  if (method.toUpperCase() === "OPTIONS") return null;
  if (NEGOTIATION_EXEMPT_PATHS.includes(pathname)) return null;
  if (isJsonAcceptable(accept)) return null;
  return {
    status: 406,
    body: {
      error: `Not Acceptable — ${pathname} returns application/json only, and the request's Accept header does not accept it. See GET /api/openapi for the documented routes.`,
    },
  };
}

/** The 406 JSON response, or null when the request passes through. */
export function notAcceptableResponse(
  pathname: string,
  method: string,
  accept: string | null,
): NextResponse | null {
  const described = describeNotAcceptable(pathname, method, accept);
  if (!described) return null;
  return NextResponse.json(described.body, { status: described.status });
}
