import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PayPalError, SandboxPayPalClient, type FetchFn } from "@/lib/paypal";
import type { WebhookEvent } from "@/lib/types";

/**
 * Sandbox OAuth token refresh tests — when PayPal answers an API
 * call with 401, the cached access token is the suspect: it may
 * have expired early, been revoked, or had its lifetime overstated
 * by the token response's `expires_in`. Until this behaviour
 * existed, the adapter kept sending the same cached token until
 * its locally computed expiry, so one bad token failed every call
 * — reads, mutations, and webhook-signature verification alike —
 * with no recovery path.
 *
 * The behaviour pinned here:
 *  - A 401 invalidates the cached token, fetches a fresh one, and
 *    retries the call exactly once. A 401 means PayPal rejected
 *    the request before processing it, so the retry cannot have
 *    duplicated a mutation; the retry of a mutating call reuses
 *    the SAME `PayPal-Request-Id` minted for the logical call.
 *  - A second 401 surfaces as the ordinary `PayPalError` (status
 *    401, PayPal's own error name) — no retry loop.
 *  - Non-401 failures never trigger a refresh or a retry.
 *  - A token response whose `expires_in` is missing is already
 *    defaulted; one that is non-numeric, non-positive, or
 *    non-finite now falls back to the same default lifetime
 *    instead of poisoning the cache expiry with NaN (which
 *    silently disabled caching) or a past instant.
 *
 * Exercised against stub fetches with FAKE credentials and fake
 * tokens. No network, no real PayPal account.
 */

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface SeenRequest {
  url: string;
  method: string;
  authorization: string | null;
  requestId: string | null;
}

interface StubOptions {
  /** Tokens the token endpoint issues, in order (the last one repeats). */
  tokens: string[];
  /** Tokens the API accepts; any other Bearer token gets a 401. */
  acceptedTokens: string[];
  /** Raw `expires_in` value for token responses (default 3600). */
  expiresIn?: unknown;
  /** When set, every API call answers this status instead of the token check. */
  apiStatusOverride?: number;
}

function makeStub(options: StubOptions) {
  const seen: SeenRequest[] = [];
  let tokenCalls = 0;
  const fetchFn: FetchFn = (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({
      url,
      method: init?.method ?? "GET",
      authorization: headers.Authorization ?? headers.authorization ?? null,
      requestId: headers["PayPal-Request-Id"] ?? null,
    });
    const path = new URL(url).pathname;
    if (path === "/v1/oauth2/token") {
      tokenCalls += 1;
      const issued = options.tokens[Math.min(tokenCalls - 1, options.tokens.length - 1)];
      return Promise.resolve(
        json(200, {
          access_token: issued,
          token_type: "Bearer",
          expires_in: options.expiresIn === undefined ? 3600 : options.expiresIn,
        }),
      );
    }
    if (options.apiStatusOverride !== undefined) {
      return Promise.resolve(
        json(options.apiStatusOverride, { name: "RESOURCE_NOT_FOUND", message: "not here" }),
      );
    }
    const bearer = (headers.Authorization ?? "").replace(/^Bearer /, "");
    if (!options.acceptedTokens.includes(bearer)) {
      return Promise.resolve(
        json(401, { name: "AUTHENTICATION_FAILURE", message: "Authentication failed due to invalid authentication credentials" }),
      );
    }
    if (path === "/v1/notifications/verify-webhook-signature") {
      return Promise.resolve(json(200, { verification_status: "SUCCESS" }));
    }
    // Generic successful read: an empty invoice list object.
    return Promise.resolve(json(200, { items: [] }));
  };
  return { fetchFn, seen, tokenCalls: () => tokenCalls, apiSeen: () => seen.filter((r) => !r.url.includes("/v1/oauth2/token")) };
}

function makeClient(fetchFn: FetchFn): SandboxPayPalClient {
  return new SandboxPayPalClient({
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    webhookId: "WH-ID-1",
    fetchFn,
    now: () => Date.parse("2026-10-14T12:00:00Z"),
  });
}

const EVENT: WebhookEvent = {
  id: "WH-EVENT-1",
  event_type: "INVOICING.INVOICE.PAID",
  summary: "Invoice paid",
  resource: { id: "INV2-1" },
} as unknown as WebhookEvent;

const HEADERS: Record<string, string> = {
  "paypal-transmission-id": "t-1",
  "paypal-transmission-sig": "sig-1",
  "paypal-transmission-time": "2026-10-14T12:00:00Z",
  "paypal-cert-url": "https://example.invalid/cert",
  "paypal-auth-algo": "SHA256withRSA",
};

describe("sandbox OAuth token refresh on 401", () => {
  it("refreshes the cached token and retries a read exactly once after a 401", async () => {
    const stub = makeStub({ tokens: ["token-stale", "token-fresh"], acceptedTokens: ["token-fresh"] });
    const client = makeClient(stub.fetchFn);
    const invoices = await client.listInvoices();
    expect(invoices).toEqual([]);
    expect(stub.tokenCalls()).toBe(2);
    const api = stub.apiSeen();
    expect(api).toHaveLength(2);
    expect(api[0]?.authorization).toBe("Bearer " + "token-stale");
    expect(api[1]?.authorization).toBe("Bearer " + "token-fresh");
  });

  it("keeps using the refreshed token for later calls (no second refresh)", async () => {
    const stub = makeStub({ tokens: ["token-stale", "token-fresh"], acceptedTokens: ["token-fresh"] });
    const client = makeClient(stub.fetchFn);
    await client.listInvoices();
    await client.listDisputes();
    expect(stub.tokenCalls()).toBe(2);
    expect(stub.apiSeen()).toHaveLength(3);
  });

  it("surfaces a persistent 401 as a PayPalError after exactly one retry", async () => {
    const stub = makeStub({ tokens: ["token-a", "token-b"], acceptedTokens: [] });
    const client = makeClient(stub.fetchFn);
    const err = await client.listInvoices().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    const paypalErr = err as PayPalError;
    expect(paypalErr.status).toBe(401);
    expect(paypalErr.name_).toBe("AUTHENTICATION_FAILURE");
    expect(stub.tokenCalls()).toBe(2);
    expect(stub.apiSeen()).toHaveLength(2);
  });

  it("reuses the same PayPal-Request-Id when retrying a mutating call", async () => {
    const stub = makeStub({ tokens: ["token-stale", "token-fresh"], acceptedTokens: ["token-fresh"] });
    const client = makeClient(stub.fetchFn);
    await client.createPayout({
      items: [
        {
          recipient: { name: "Marco", email_address: "marco@example.com" },
          amount: { currency_code: "USD", value: "200.00" },
        },
      ],
    }).catch(() => undefined);
    const posts = stub.apiSeen().filter((r) => r.method === "POST" && r.url.includes("/v1/payments/payouts"));
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts[0]?.requestId).toBeTruthy();
    expect(posts[1]?.requestId).toBe(posts[0]?.requestId);
    expect(posts[1]?.authorization).toBe("Bearer " + "token-fresh");
  });

  it("does not refresh or retry on a non-401 failure", async () => {
    const stub = makeStub({ tokens: ["token-only"], acceptedTokens: ["token-only"], apiStatusOverride: 404 });
    const client = makeClient(stub.fetchFn);
    const err = await client.listInvoices().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).status).toBe(404);
    expect(stub.tokenCalls()).toBe(1);
    expect(stub.apiSeen()).toHaveLength(1);
  });

  it("recovers webhook-signature verification whose first attempt hits a stale token", async () => {
    const stub = makeStub({ tokens: ["token-stale", "token-fresh"], acceptedTokens: ["token-fresh"] });
    const client = makeClient(stub.fetchFn);
    const verified = await client.verifyWebhookSignature(HEADERS, EVENT);
    expect(verified).toBe(true);
    expect(stub.tokenCalls()).toBe(2);
  });

  it("treats a non-numeric expires_in as the default lifetime (cache stays usable)", async () => {
    const stub = makeStub({ tokens: ["token-only"], acceptedTokens: ["token-only"], expiresIn: "not-a-number" });
    const client = makeClient(stub.fetchFn);
    await client.listInvoices();
    await client.listInvoices();
    expect(stub.tokenCalls()).toBe(1);
  });

  it("treats a non-positive expires_in as the default lifetime", async () => {
    const stub = makeStub({ tokens: ["token-only"], acceptedTokens: ["token-only"], expiresIn: 0 });
    const client = makeClient(stub.fetchFn);
    await client.listInvoices();
    await client.listInvoices();
    expect(stub.tokenCalls()).toBe(1);
  });

  it("README documents the 401 token refresh", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("cached OAuth token is treated as the suspect");
    expect(readme).toContain("invalidates it, fetches a fresh token");
    expect(readme).toContain("retries the call exactly once");
    expect(readme).toContain("non-positive, or non-finite falls");
  });
});
