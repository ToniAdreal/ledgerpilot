/**
 * API guards — the only middleware in the app.
 *
 * Three request-side guards over `/api/*`, in order:
 *  1. A wrong-method call to a documented API path is answered
 *     with the JSON 405 from `src/lib/api/method-not-allowed.ts`
 *     (shared `{ error }` shape + `Allow` header, resolved from the
 *     OpenAPI operation registry) instead of the framework's
 *     empty-body 405.
 *  2. A request whose `Accept` header excludes the API's one
 *     representation (`application/json`) is answered with the
 *     JSON 406 from `src/lib/api/not-acceptable.ts`, with the two
 *     documented exemptions (OPTIONS, and the PayPal webhook
 *     listener whose machine-peer sender does not negotiate).
 *  3. A client POSTing past the per-client limit (120 POSTs per
 *     60 seconds; reads are never counted) is answered with the
 *     JSON 429 from `src/lib/api/rate-limit.ts` (shared
 *     `{ error }` shape + `Retry-After` header).
 *
 * Everything else — acceptable method + path + Accept triples,
 * HEAD (which the framework answers itself), unknown paths (the
 * catch-all's JSON 404), and every page request — passes through
 * untouched: the matcher covers `/api/*` only, and each module
 * returns null for any request it does not govern.
 *
 * The guards build no agent runtime and read no credentials, so
 * they behave identically on healthy, degraded, and misconfigured
 * instances.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { methodNotAllowedResponse } from "./lib/api/method-not-allowed";
import { notAcceptableResponse } from "./lib/api/not-acceptable";
import { rateLimitResponse } from "./lib/api/rate-limit";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  return (
    methodNotAllowedResponse(pathname, request.method) ??
    notAcceptableResponse(pathname, request.method, request.headers.get("accept")) ??
    rateLimitResponse(pathname, request.method, request.headers) ??
    NextResponse.next()
  );
}

export const config = { matcher: "/api/:path*" };
