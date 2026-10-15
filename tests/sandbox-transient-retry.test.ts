import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PayPalError,
  SANDBOX_TRANSIENT_RETRY_DEFAULT_DELAY_MS,
  SANDBOX_TRANSIENT_RETRY_MAX_DELAY_MS,
  SandboxPayPalClient,
  type FetchFn,
} from "@/lib/paypal";

/**
 * Sandbox transient-error retry tests — a GET call that PayPal
 * answers 429 (rate limited) or 503 (temporarily unavailable)
 * is retried exactly once after a bounded delay; everything else
 * surfaces at once.
 *
 * The behaviour pinned here:
 *  - Reads only: a 429/503 answer to a mutating POST is never
 *    retried by this path (the mutation's outcome is not knowable
 *    from the status alone) and surfaces as the ordinary
 *    `PayPalError` after exactly one attempt.
 *  - Exactly once: a second 429/503 surfaces as the ordinary
 *    `PayPalError` — there is no retry loop.
 *  - The delay is the response's `Retry-After` delta-seconds
 *    when usable, the 250 ms default otherwise, and never above
 *    the 2,000 ms cap however large the header is.
 *  - The OAuth token fetch is outside the retried path: a
 *    transient answer from the token endpoint fails at once.
 *  - The retry is independent of the 401 token refresh: each
 *    mechanism fires at most once per logical call (a read that
 *    meets 429 then 401 still completes, in three attempts).
 *
 * Exercised against stub fetches with FAKE credentials, an
 * injected sleep that only records delays, and a fixed clock.
 * No network, no real PayPal account, no real waiting.
 */

function json(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface Harness {
  client: SandboxPayPalClient;
  apiCalls: string[];
  tokenCalls: () => number;
  delays: number[];
}

/**
 * Build a client whose API answers come from a queue (the last
 * response repeats if the queue runs out) and whose token
 * endpoint always issues a token — unless `tokenStatus` says
 * otherwise, in which case it always answers that status.
 */
function makeHarness(apiResponses: Response[], tokenStatus = 200): Harness {
  const apiCalls: string[] = [];
  const delays: number[] = [];
  let tokenCount = 0;
  let served = 0;
  const fetchFn: FetchFn = (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/v1/oauth2/token") {
      tokenCount += 1;
      if (tokenStatus !== 200) {
        return Promise.resolve(json(tokenStatus, { name: "TRANSIENT", message: "slow down" }));
      }
      return Promise.resolve(
        json(200, { access_token: "fake-token", token_type: "Bearer", expires_in: 3600 }),
      );
    }
    apiCalls.push(`${init?.method ?? "GET"} ${path}`);
    const res = apiResponses[Math.min(served, apiResponses.length - 1)]!;
    served += 1;
    // A Response body can be read only once; hand out a clone so a
    // repeated queue entry stays readable.
    return Promise.resolve(res.clone());
  };
  const client = new SandboxPayPalClient({
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    fetchFn,
    now: () => 1_700_000_000_000,
    sleepFn: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  });
  return { client, apiCalls, tokenCalls: () => tokenCount, delays };
}

const INVOICE = {
  id: "INV2-TEST-1",
  status: "SENT",
  detail: { invoice_number: "LP-TEST-1" },
  primary_recipients: [{ billing_info: { name: { given_name: "Ana" }, email_address: "ana@example.com" } }],
  items: [{ name: "Logo work", quantity: "1", unit_amount: { currency_code: "USD", value: "10.00" } }],
  amount: { currency_code: "USD", value: "10.00" },
  due_amount: { currency_code: "USD", value: "10.00" },
};

describe("sandbox transient-error retry (reads only, exactly once)", () => {
  it("exports the delay constants", () => {
    expect(SANDBOX_TRANSIENT_RETRY_DEFAULT_DELAY_MS).toBe(250);
    expect(SANDBOX_TRANSIENT_RETRY_MAX_DELAY_MS).toBe(2_000);
  });

  it("retries a 429 read once, after the default delay, and returns the retried response", async () => {
    const h = makeHarness([
      json(429, { name: "RATE_LIMIT_REACHED", message: "slow down" }),
      json(200, INVOICE),
    ]);
    const invoice = await h.client.getInvoice("INV2-TEST-1");
    expect(invoice.id).toBe("INV2-TEST-1");
    expect(h.apiCalls).toHaveLength(2);
    expect(h.delays).toEqual([SANDBOX_TRANSIENT_RETRY_DEFAULT_DELAY_MS]);
  });

  it("retries a 503 read once", async () => {
    const h = makeHarness([
      json(503, { name: "SERVICE_UNAVAILABLE", message: "maintenance" }),
      json(200, { items: [] }),
    ]);
    await expect(h.client.listDisputes()).resolves.toEqual([]);
    expect(h.apiCalls).toHaveLength(2);
    expect(h.delays).toEqual([250]);
  });

  it("honours a usable Retry-After delta-seconds", async () => {
    const h = makeHarness([
      json(429, { name: "RATE_LIMIT_REACHED", message: "slow down" }, { "retry-after": "1" }),
      json(200, INVOICE),
    ]);
    await h.client.getInvoice("INV2-TEST-1");
    expect(h.delays).toEqual([1_000]);
  });

  it("caps an oversized Retry-After at the maximum delay", async () => {
    const h = makeHarness([
      json(503, { name: "SERVICE_UNAVAILABLE", message: "maintenance" }, { "retry-after": "30" }),
      json(200, INVOICE),
    ]);
    await h.client.getInvoice("INV2-TEST-1");
    expect(h.delays).toEqual([SANDBOX_TRANSIENT_RETRY_MAX_DELAY_MS]);
  });

  it("accepts Retry-After: 0 as an immediate retry", async () => {
    const h = makeHarness([
      json(429, { name: "RATE_LIMIT_REACHED", message: "slow down" }, { "retry-after": "0" }),
      json(200, INVOICE),
    ]);
    await h.client.getInvoice("INV2-TEST-1");
    expect(h.delays).toEqual([0]);
  });

  it("falls back to the default delay for an unparseable Retry-After", async () => {
    const h = makeHarness([
      json(429, { name: "RATE_LIMIT_REACHED", message: "slow down" }, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
      json(200, INVOICE),
    ]);
    await h.client.getInvoice("INV2-TEST-1");
    expect(h.delays).toEqual([250]);
  });

  it("surfaces a second transient answer as the ordinary PayPalError — no retry loop", async () => {
    const h = makeHarness([
      json(429, { name: "RATE_LIMIT_REACHED", message: "slow down" }),
      json(429, { name: "RATE_LIMIT_REACHED", message: "still slow" }),
      json(200, INVOICE),
    ]);
    const err = await h.client.getInvoice("INV2-TEST-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).status).toBe(429);
    expect((err as PayPalError).name_).toBe("RATE_LIMIT_REACHED");
    expect(h.apiCalls).toHaveLength(2);
    expect(h.delays).toEqual([250]);
  });

  it("never retries a mutating call on a transient answer", async () => {
    const h = makeHarness([json(429, { name: "RATE_LIMIT_REACHED", message: "slow down" })]);
    const err = await h.client
      .recordInvoicePayment("INV2-TEST-1", { value: "10.00", currency_code: "USD" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).status).toBe(429);
    expect(h.apiCalls).toHaveLength(1);
    expect(h.delays).toEqual([]);
  });

  it("never retries a non-transient failure", async () => {
    const h = makeHarness([json(404, { name: "RESOURCE_NOT_FOUND", message: "not here" })]);
    const err = await h.client.getInvoice("INV2-NOPE").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).status).toBe(404);
    expect(h.apiCalls).toHaveLength(1);
    expect(h.delays).toEqual([]);
  });

  it("does not retry a transient answer from the OAuth token endpoint", async () => {
    const h = makeHarness([json(200, INVOICE)], 503);
    const err = await h.client.getInvoice("INV2-TEST-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).status).toBe(503);
    expect(h.tokenCalls()).toBe(1);
    expect(h.apiCalls).toEqual([]);
    expect(h.delays).toEqual([]);
  });

  it("composes with the 401 token refresh: 429, then 401, then success in three attempts", async () => {
    const h = makeHarness([
      json(429, { name: "RATE_LIMIT_REACHED", message: "slow down" }),
      json(401, { name: "INVALID_ACCESS_TOKEN", message: "token rejected" }),
      json(200, INVOICE),
    ]);
    const invoice = await h.client.getInvoice("INV2-TEST-1");
    expect(invoice.id).toBe("INV2-TEST-1");
    expect(h.apiCalls).toHaveLength(3);
    expect(h.tokenCalls()).toBe(2);
    expect(h.delays).toEqual([250]);
  });

  it("retries each page of a paginated list independently", async () => {
    const page1 = {
      items: [{ dispute_id: "PP-D-1" }],
      links: [{ href: "https://api-m.sandbox.paypal.com/v1/customer/disputes?page_size=50&page=2", rel: "next", method: "GET" }],
    };
    const h = makeHarness([
      json(503, { name: "SERVICE_UNAVAILABLE", message: "maintenance" }),
      json(200, page1),
      json(200, { items: [{ dispute_id: "PP-D-2" }] }),
    ]);
    const disputes = await h.client.listDisputes();
    expect(disputes.map((d) => d.dispute_id)).toEqual(["PP-D-1", "PP-D-2"]);
    expect(h.apiCalls).toHaveLength(3);
    expect(h.delays).toEqual([250]);
  });

  it("is documented in the README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("SANDBOX_TRANSIENT_RETRY_MAX_DELAY_MS");
    expect(readme).toContain("Retry-After");
  });
});
