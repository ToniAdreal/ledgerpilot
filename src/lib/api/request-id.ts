/**
 * Request id — the `X-Request-Id` header on every API response.
 *
 * LedgerPilot's product story is an audit trail inside the app:
 * every agent action, PayPal call, and webhook is written to the
 * activity log. Until this module existed, the HTTP layer itself
 * had no correlation handle: an operator (or a judge) reporting
 * "this click failed" could not name the request, and nothing in
 * a response tied it to the exchange that produced it. Every
 * response under `/api/` now carries one request id, resolved
 * by middleware (`src/middleware.ts`) before any guard runs, so
 * guard refusals (405 / 406 / 429) carry the same header as
 * routed responses — a refused request is exactly the kind an
 * operator most needs to name.
 *
 * The rules, in code:
 *  - **Echo a valid inbound id.** A client that sends
 *    `X-Request-Id` with a value matching the safe shape below
 *    gets that exact value back, so a caller's own trace id
 *    survives the round trip and can be matched against the
 *    caller's logs.
 *  - **Generate otherwise.** A missing header — or a value
 *    outside the safe shape — is replaced with a generated
 *    `req-<uuid>` id. An invalid value is never echoed: echoing
 *    arbitrary header text into a response header (and, by
 *    extension, into logs that record it) is a header-injection
 *    and log-forging surface, so the safe shape is a whitelist:
 *    1–128 characters of ASCII letters, digits, `.`, `_`, `-`.
 *    No spaces, no separators, no control characters, no
 *    non-ASCII.
 *  - **Not an identity.** Like the rate limit's client key, the
 *    id is a correlation handle, not authentication: a caller
 *    can choose any valid value, and no decision in the app is
 *    made from it. It names a request; it does not vouch for
 *    whoever sent it.
 *
 * The module builds no agent runtime and reads no credentials,
 * so it behaves identically on healthy, degraded, and
 * misconfigured instances. Generation is injectable so tests
 * never depend on randomness.
 */

import { NextResponse } from "next/server";

/** The header name, lower-cased as `Headers` normalises it. */
export const REQUEST_ID_HEADER = "x-request-id";

/** The header name as it appears in the OpenAPI document. */
export const REQUEST_ID_HEADER_TITLE = "X-Request-Id";

/** Maximum accepted length of a client-supplied request id. */
export const MAX_REQUEST_ID_LENGTH = 128;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Pure check: is this a client-supplied request id the API will
 * echo? Only the whitelist shape above — anything else (null,
 * empty, over-long, whitespace, separators, non-ASCII) is not a
 * value this API will reflect into a response header.
 */
export function isValidRequestId(value: string | null): value is string {
  if (value === null) return false;
  return REQUEST_ID_PATTERN.test(value);
}

/** Generate one request id: `req-` followed by a random UUID. */
export function generateRequestId(randomId: () => string = () => crypto.randomUUID()): string {
  return `req-${randomId()}`;
}

/**
 * Resolve the id a request will be answered under: the inbound
 * `X-Request-Id` when it is valid, a generated id otherwise.
 * `generate` is injectable for tests.
 */
export function resolveRequestId(
  inbound: string | null,
  generate: () => string = generateRequestId,
): string {
  return isValidRequestId(inbound) ? inbound : generate();
}

/** Resolve the request id directly from a request's headers. */
export function requestIdFromHeaders(
  headers: Headers,
  generate: () => string = generateRequestId,
): string {
  return resolveRequestId(headers.get(REQUEST_ID_HEADER), generate);
}

/**
 * Stamp the resolved id onto a response and return it, so
 * middleware can apply it uniformly to guard refusals and to
 * the pass-through response alike. Any id the response already
 * carries is replaced — there is exactly one request id per
 * response, and it is the one resolved for this request.
 */
export function applyRequestId<T extends NextResponse>(response: T, requestId: string): T {
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}
