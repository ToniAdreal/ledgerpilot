/**
 * JSON request-body reading — the non-object body case, and the
 * oversized body case.
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
 *
 * The size limit is the same module's second case. Every legitimate
 * body in this API is small and bounded by validation caps that
 * already exist in code (briefs ≤ 500 chars, text fields ≤ 500
 * chars, payout batches ≤ 25 lines, tool sequences ≤ 4 calls — the
 * largest legitimate body, a maximum-size payout batch draft, is
 * roughly 27 KB), but until this limit existed a single request
 * could force the server to buffer and parse an arbitrarily large
 * payload before any of that validation ran — on a hosted demo
 * instance that deliberately ships with no authentication layer,
 * that is a real denial-of-service surface. The reader therefore
 * measures the raw body's UTF-8 byte length and answers
 * `413 Payload Too Large` in the same shared `{ error }` shape —
 * naming the limit — *before* parsing, so an oversized body is
 * rejected for its size whether or not it is well-formed JSON, and
 * never reaches a validator, the runtime, or PayPal. The limit is
 * 128 KiB: more than four times the largest legitimate body, so
 * no valid request is ever rejected for size (the test suite pins
 * that headroom against a maximum-size payout batch). The suggest
 * route applies the same limit to its raw text before parsing.
 */

import { NextResponse } from "next/server";

/** Maximum accepted size of a JSON request body, in UTF-8 bytes (128 KiB). */
export const MAX_JSON_BODY_BYTES = 131_072;

/** The 413 error message, shared by every body-reading surface. */
export const JSON_BODY_TOO_LARGE_ERROR = `Request body is too large — JSON request bodies are limited to ${MAX_JSON_BODY_BYTES} bytes`;

/** UTF-8 byte length of a raw body — the unit the size limit is measured in (not characters). */
export function jsonBodyByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Pure check: does a body's UTF-8 byte length exceed the limit? Exactly at the limit is accepted. */
export function isOversizedJsonBody(byteLength: number): boolean {
  return byteLength > MAX_JSON_BODY_BYTES;
}

/** The shared 413 response: `{ error }` naming the limit, nothing else. */
export function payloadTooLargeResponse(): NextResponse {
  return NextResponse.json({ error: JSON_BODY_TOO_LARGE_ERROR }, { status: 413 });
}

/** Pure check: a parsed JSON value is an object body only if it is a non-null, non-array object. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a route's JSON object body. On success returns
 * `{ body, response: null }`; on an oversized body returns the
 * shared 413; on malformed JSON or a non-object body returns
 * `{ body: null, response }` with the 400 to send instead,
 * carrying `errorMessage` in the shared `{ error }` shape.
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
  let text: string;
  try {
    text = await req.text();
  } catch {
    return reject();
  }
  if (isOversizedJsonBody(jsonBodyByteLength(text))) {
    return { body: null, response: payloadTooLargeResponse() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return reject();
  }
  if (!isJsonObject(parsed)) return reject();
  return { body: parsed, response: null };
}
