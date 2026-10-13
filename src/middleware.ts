/**
 * API method guard — the only middleware in the app.
 *
 * A wrong-method call to a documented API path is answered here
 * with the JSON 405 from `src/lib/api/method-not-allowed.ts`
 * (shared `{ error }` shape + `Allow` header, resolved from the
 * OpenAPI operation registry) instead of the framework's empty-body
 * 405. Everything else — documented method + path pairs, HEAD /
 * OPTIONS (which the framework answers itself), unknown paths
 * (the catch-all's JSON 404), and every page request — passes
 * through untouched: the matcher covers `/api/*` only, and the
 * module returns null for any request it does not govern.
 *
 * The guard builds no agent runtime and reads no credentials, so
 * it behaves identically on healthy, degraded, and misconfigured
 * instances.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { methodNotAllowedResponse } from "./lib/api/method-not-allowed";

export function middleware(request: NextRequest) {
  return (
    methodNotAllowedResponse(request.nextUrl.pathname, request.method) ??
    NextResponse.next()
  );
}

export const config = { matcher: "/api/:path*" };
