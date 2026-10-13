/**
 * Unknown API routes — the JSON 404 for paths under `/api/` that no
 * route file implements.
 *
 * Until this module existed, a mistyped or stale API path (an
 * operator's curl, a judge's client, an outdated link into the API)
 * fell through to the App Router's page-level not-found handling and
 * answered `404 text/html` — the branded HTML page — while every
 * implemented route answers JSON in the API's one shared error shape
 * (`{ error: string }`, the shape the OpenAPI document models as its
 * `Error` component). An API consumer parsing that response as JSON
 * failed on a path error that should have been the simplest one to
 * diagnose.
 *
 * The catch-all route (`src/app/api/[[...slug]]/route.ts`) delegates
 * here for every method. It never builds the agent runtime — an
 * unknown path is unknown in every mode, including a misconfigured
 * sandbox instance, whose implemented routes answer 503 while its
 * unknown paths still answer this 404. Concrete routes always take
 * precedence over the catch-all, so nothing implemented is shadowed.
 *
 * The message names the requested path (segments only — never a
 * query string, header, or credential value) and points at the
 * machine-readable route map.
 */

import { NextResponse } from "next/server";

export interface UnknownApiRouteDescription {
  status: 404;
  body: { error: string };
}

/** The `/api/...` path for catch-all segments (`undefined`/empty → the `/api` root itself). */
export function unknownApiPath(segments: readonly string[] | undefined): string {
  if (!segments || segments.length === 0) return "/api";
  return `/api/${segments.join("/")}`;
}

/** Pure description: the shared error shape, the requested path, and the route-map pointer. */
export function describeUnknownApiRoute(
  segments: readonly string[] | undefined,
): UnknownApiRouteDescription {
  return {
    status: 404,
    body: {
      error: `Unknown API route: ${unknownApiPath(segments)}. See GET /api/openapi for the documented routes.`,
    },
  };
}

/** The 404 JSON response for an unknown API path. */
export function unknownApiRouteResponse(segments: readonly string[] | undefined): NextResponse {
  const described = describeUnknownApiRoute(segments);
  return NextResponse.json(described.body, { status: described.status });
}
