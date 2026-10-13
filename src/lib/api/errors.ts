/**
 * API error translation — the runtime-not-configured case.
 *
 * Every runtime-backed route builds the agent runtime first
 * (`getAgentRuntime()`), and in sandbox mode without credentials that
 * construction throws `PayPalNotConfiguredError`. Until this module
 * existed, the throw escaped the route handler and Next.js answered
 * with its opaque HTML 500 — an instance could be up, correctly
 * diagnosed by `GET /api/health` as `misconfigured`, and still give
 * an operator hitting any other route nothing to act on. (The health
 * run recorded exactly that contrast live.)
 *
 * The translation, applied at the one place every runtime-backed
 * handler starts:
 *  - `describePayPalNotConfigured` is the pure half: a
 *    `PayPalNotConfiguredError` maps to HTTP 503 with the app's one
 *    shared error shape (`{ error: string }` — the shape the OpenAPI
 *    document models as its `Error` component, with no extra fields).
 *    The error's own message already names the missing variables and
 *    the mock-mode alternative, so the body is safe to show an
 *    operator verbatim and never carries a credential value.
 *  - Any other error maps to `null` and is rethrown untouched — this
 *    module translates the one known configuration failure, it does
 *    not swallow unknown failures into a friendly shape.
 *  - `acquireRuntime` is the route-facing wrapper: it returns the
 *    runtime, or the 503 response to return instead. Routes that do
 *    not build the runtime (health, the OpenAPI document, the tool
 *    definitions' GET) never call it and are unaffected.
 */

import { NextResponse } from "next/server";

import { getAgentRuntime, type AgentRuntime } from "../agent/runtime";
import { PayPalNotConfiguredError } from "../paypal/client";

export interface ApiErrorDescription {
  status: 503;
  body: { error: string };
}

/** Pure translation: the not-configured error → 503 + shared error shape; anything else → null. */
export function describePayPalNotConfigured(err: unknown): ApiErrorDescription | null {
  if (!(err instanceof PayPalNotConfiguredError)) return null;
  return { status: 503, body: { error: err.message } };
}

/** The 503 JSON response for a not-configured error, or null for any other error. */
export function paypalNotConfiguredResponse(err: unknown): NextResponse | null {
  const described = describePayPalNotConfigured(err);
  if (!described) return null;
  return NextResponse.json(described.body, { status: described.status });
}

/**
 * Build the agent runtime for a route handler. On success returns
 * `{ runtime, response: null }`; when the runtime cannot be built
 * because sandbox mode is selected without credentials, returns
 * `{ runtime: null, response }` with the 503 to send instead. Any
 * other construction failure is rethrown untouched.
 */
export function acquireRuntime():
  | { runtime: AgentRuntime; response: null }
  | { runtime: null; response: NextResponse } {
  try {
    return { runtime: getAgentRuntime(), response: null };
  } catch (err) {
    const response = paypalNotConfiguredResponse(err);
    if (response) return { runtime: null, response };
    throw err;
  }
}
