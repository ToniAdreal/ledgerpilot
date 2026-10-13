/**
 * JSON request-body reading — the non-object body case.
 *
 * `Request.json()` parses *any* JSON value, not just objects. Every
 * POST route in this app expects an object body, and until this
 * module existed each route cast the parsed value straight to its
 * object shape. A body of `null` slipped through that cast and the
 * first field dereference (`body.planId`, `body.brief`, …) threw a
 * TypeError that escaped the handler — Next.js answered an opaque
 * HTML 500 for a client error the route's own documentation already
 * promised as a 400. Array and scalar bodies (`[]`, `"text"`, `42`)
 * were one dereference away from the same failure, and each route's
 * `?? {}` / `?.` patchwork covered a different subset.
 *
 * The translation, applied at the one place every object-body POST
 * handler starts:
 *  - `isJsonObject` is the pure half: a parsed value is a body only
 *    when it is a non-null, non-array object.
 *  - `readJsonObjectBody` is the route-facing wrapper, shaped like
 *    `acquireRuntime`: it returns the body, or the 400 response to
 *    return instead — in the API's one shared error shape
 *    (`{ error }`), carrying the route's own message so each route
 *    keeps the guidance its documentation promises. Malformed JSON
 *    and well-formed non-object JSON get the same 400: from the
 *    route's perspective both are "not the object body required".
 *  - The one deliberate exception is `POST /api/agent/suggest`: its
 *    body is optional (an empty body is valid), so it reads the raw
 *    text itself and applies the same object check to a present
 *    body. Routes that take no body at all (the Judge Mode seed /
 *    pay / reset actions) never call this module.
 */

import { NextResponse } from "next/server";

/** Pure check: a parsed JSON value is an object body only if it is a non-null, non-array object. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a route's JSON object body. On success returns
 * `{ body, response: null }`; on malformed JSON or a non-object
 * body returns `{ body: null, response }` with the 400 to send
 * instead, carrying `errorMessage` in the shared `{ error }` shape.
 */
export async function readJsonObjectBody(
  req: Request,
  errorMessage: string,
): Promise<
  | { body: Record<string, unknown>; response: null }
  | { body: null; response: NextResponse }
> {
  const reject = (): { body: null; response: NextResponse } => ({
    body: null,
    response: NextResponse.json({ error: errorMessage }, { status: 400 }),
  });
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return reject();
  }
  if (!isJsonObject(parsed)) return reject();
  return { body: parsed, response: null };
}
