/**
 * Method not allowed — the JSON 405 for a documented API path called
 * with a method that path does not support.
 *
 * Until this module existed, a wrong-method call to a *known* path
 * (POST to a GET-only route, DELETE on a read model, a browser's GET
 * on a POST-only draft endpoint) was answered by the framework
 * itself: `405 Method Not Allowed` with a completely empty body —
 * no JSON, no `Allow` header, not even the name of a method that
 * would have worked — while every response a route file produces
 * uses the API's one shared error shape (`{ error: string }`, the
 * shape the OpenAPI document models as its `Error` component).
 *
 * The fix is middleware (`src/middleware.ts`) over this module, and
 * the source of truth is the OpenAPI operation registry
 * (`API_OPERATIONS` in `src/lib/api/openapi.ts`) — the same list the
 * OpenAPI document and the `/api-docs` page are built from, whose
 * completeness the test suite enforces against the route files on
 * disk. There is no second path→method table to drift: a route
 * added to the registry is covered here automatically, and a path
 * the registry does not document is not this module's concern (the
 * catch-all answers it with the JSON 404, in every method).
 *
 * Two framework behaviours pass through untouched, by design:
 *  - `HEAD` on a path that documents `GET` — the framework serves
 *    HEAD from the GET handler; and
 *  - `OPTIONS` on any documented path — the framework answers it
 *    itself from the route's exported methods.
 *
 * The module builds no agent runtime, so a wrong-method call gets
 * its 405 even on a misconfigured sandbox instance (whose
 * implemented routes answer the structured 503). The message names
 * the requested path (the URL path only — never a query string,
 * header, or credential value) and the allowed methods, and points
 * at the machine-readable route map.
 */

import { NextResponse } from "next/server";
import { API_OPERATIONS } from "./openapi";

export interface MethodNotAllowedDescription {
  status: 405;
  /** Methods the `Allow` header carries: the documented methods, plus HEAD where GET is documented (the framework serves it). */
  allow: string[];
  body: { error: string };
}

/** Does a registry path template match this concrete pathname? A `{param}` segment matches exactly one non-empty segment. */
function apiPathMatches(template: string, pathname: string): boolean {
  const templateSegments = template.split("/");
  const pathSegments = pathname.split("/");
  if (templateSegments.length !== pathSegments.length) return false;
  return templateSegments.every((segment, i) =>
    segment.startsWith("{") && segment.endsWith("}")
      ? pathSegments[i].length > 0
      : segment === pathSegments[i],
  );
}

/**
 * The documented methods for a concrete API pathname, in registry
 * order (uppercase), or null when the registry documents no
 * operation for the path — unknown paths belong to the catch-all.
 */
export function allowedMethodsForApiPath(pathname: string): string[] | null {
  const methods: string[] = [];
  for (const op of API_OPERATIONS) {
    if (!apiPathMatches(op.path, pathname)) continue;
    const method = op.method.toUpperCase();
    if (!methods.includes(method)) methods.push(method);
  }
  return methods.length > 0 ? methods : null;
}

/**
 * Pure description of the 405 for a wrong-method call, or null when
 * the request must pass through: the path is undocumented, the
 * method is documented for it, or the framework answers the method
 * itself (HEAD via a GET handler, OPTIONS).
 */
export function describeMethodNotAllowed(
  pathname: string,
  method: string,
): MethodNotAllowedDescription | null {
  const documented = allowedMethodsForApiPath(pathname);
  if (!documented) return null;
  const verb = method.toUpperCase();
  if (documented.includes(verb)) return null;
  if (verb === "HEAD" && documented.includes("GET")) return null;
  if (verb === "OPTIONS") return null;
  const allow = documented.includes("GET") ? [...documented, "HEAD"] : [...documented];
  return {
    status: 405,
    allow,
    body: {
      error: `Method ${verb} is not allowed for ${pathname}. Allowed: ${allow.join(", ")}. See GET /api/openapi for the documented routes.`,
    },
  };
}

/** The 405 JSON response (with its `Allow` header), or null when the request passes through. */
export function methodNotAllowedResponse(pathname: string, method: string): NextResponse | null {
  const described = describeMethodNotAllowed(pathname, method);
  if (!described) return null;
  const response = NextResponse.json(described.body, { status: described.status });
  response.headers.set("Allow", described.allow.join(", "));
  return response;
}
