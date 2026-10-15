import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PayPalError, SandboxPayPalClient, type FetchFn } from "@/lib/paypal";

/**
 * Sandbox OAuth token-fetch coalescing tests — when the cached
 * token is missing or expired, every API call needs a token, and
 * the console's read routes fire several calls in parallel (the
 * summary route alone fans out to invoices, orders, payouts,
 * disputes, and transactions). Until this behaviour existed,
 * `getAccessToken` checked the cache, found it empty, and every
 * concurrent caller started its OWN token fetch before any of
 * them could populate the cache — N parallel calls meant N
 * credential exchanges against the token endpoint, with the last
 * writer winning a cache they had all raced to fill.
 *
 * The behaviour pinned here:
 *  - Concurrent callers share ONE in-flight token fetch: the
 *    token endpoint is called exactly once, every caller proceeds
 *    with the same token, and the populated cache serves later
 *    sequential calls as before.
 *  - A failed shared fetch rejects every waiter with the same
 *    `PayPalError` and is NOT retained: the next call retries the
 *    token endpoint instead of re-throwing a cached failure.
 *  - The 401 refresh path coalesces too: two parallel calls that
 *    both hit a stale token share the single refresh fetch.
 *  - After the cached token expires, a new parallel burst again
 *    coalesces to exactly one fresh fetch.
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

interface StubOptions {
  /** Tokens the token endpoint issues, in order (the last one repeats). */
  tokens: string[];
  /** Tokens the API accepts; any other Bearer token gets a 401. */
  acceptedTokens: string[];
  /** Raw `expires_in` value for token responses (default 3600). */
  expiresIn?: unknown;
  /** Number of initial token fetches that fail with this status before succeeding. */
  failingTokenFetches?: number;
  failingTokenStatus?: number;
}

function makeStub(options: StubOptions) {
  const authorizations: string[] = [];
  let tokenCalls = 0;
  const fetchFn: FetchFn = (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const path = new URL(url).pathname;
    if (path === "/v1/oauth2/token") {
      tokenCalls += 1;
      const call = tokenCalls;
      if (options.failingTokenFetches !== undefined && call <= options.failingTokenFetches) {
        return Promise.resolve(
          json(options.failingTokenStatus ?? 500, { name: "SERVER_ERROR", message: "token endpoint down" }),
        );
      }
      const issued = options.tokens[Math.min(call - 1, options.tokens.length - 1)];
      return Promise.resolve(
        json(200, {
          access_token: issued,
          token_type: "Bearer",
          expires_in: options.expiresIn === undefined ? 3600 : options.expiresIn,
        }),
      );
    }
    const bearer = (headers.Authorization ?? "").replace(/^Bearer /, "");
    authorizations.push(bearer);
    if (!options.acceptedTokens.includes(bearer)) {
      return Promise.resolve(
        json(401, { name: "AUTHENTICATION_FAILURE", message: "Authentication failed" }),
      );
    }
    // Generic successful read shape for every list endpoint used here.
    return Promise.resolve(json(200, { items: [], transaction_details: [] }));
  };
  return { fetchFn, authorizations, tokenCalls: () => tokenCalls };
}

function makeClient(fetchFn: FetchFn, now: () => number): SandboxPayPalClient {
  return new SandboxPayPalClient({
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    webhookId: "WH-ID-1",
    fetchFn,
    now,
  });
}

const FIXED_NOW = () => Date.parse("2026-10-14T12:00:00Z");

describe("sandbox OAuth token-fetch coalescing", () => {
  it("shares one token fetch across parallel calls on a cold cache", async () => {
    const stub = makeStub({ tokens: ["token-one"], acceptedTokens: ["token-one"] });
    const client = makeClient(stub.fetchFn, FIXED_NOW);
    const [invoices, disputes, payouts, transactions] = await Promise.all([
      client.listInvoices(),
      client.listDisputes(),
      client.listPayouts(),
      client.listTransactions(),
    ]);
    expect(invoices).toEqual([]);
    expect(disputes).toEqual([]);
    expect(payouts).toEqual([]);
    expect(transactions).toEqual([]);
    expect(stub.tokenCalls()).toBe(1);
    expect(stub.authorizations).toEqual(["token-one", "token-one", "token-one", "token-one"]);
  });

  it("serves later sequential calls from the cache the shared fetch populated", async () => {
    const stub = makeStub({ tokens: ["token-one"], acceptedTokens: ["token-one"] });
    const client = makeClient(stub.fetchFn, FIXED_NOW);
    await Promise.all([client.listInvoices(), client.listDisputes()]);
    await client.listInvoices();
    expect(stub.tokenCalls()).toBe(1);
  });

  it("rejects every parallel waiter when the shared token fetch fails, then retries cleanly", async () => {
    const stub = makeStub({
      tokens: ["token-later"],
      acceptedTokens: ["token-later"],
      failingTokenFetches: 1,
      failingTokenStatus: 500,
    });
    const client = makeClient(stub.fetchFn, FIXED_NOW);
    const settled = await Promise.allSettled([client.listInvoices(), client.listDisputes(), client.listPayouts()]);
    expect(stub.tokenCalls()).toBe(1);
    for (const outcome of settled) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(PayPalError);
        expect((outcome.reason as PayPalError).status).toBe(500);
      }
    }
    // The failed fetch is not retained: a later call fetches again and succeeds.
    const invoices = await client.listInvoices();
    expect(invoices).toEqual([]);
    expect(stub.tokenCalls()).toBe(2);
  });

  it("coalesces the 401 refresh fetch when parallel calls share a stale token", async () => {
    const stub = makeStub({ tokens: ["token-stale", "token-fresh"], acceptedTokens: ["token-fresh"] });
    const client = makeClient(stub.fetchFn, FIXED_NOW);
    const [invoices, disputes] = await Promise.all([client.listInvoices(), client.listDisputes()]);
    expect(invoices).toEqual([]);
    expect(disputes).toEqual([]);
    // One cold fetch (stale) + one shared refresh fetch (fresh) — not two refreshes.
    expect(stub.tokenCalls()).toBe(2);
  });

  it("coalesces a parallel burst again after the cached token expires", async () => {
    let nowMs = Date.parse("2026-10-14T12:00:00Z");
    const stub = makeStub({
      tokens: ["token-first", "token-second"],
      acceptedTokens: ["token-first", "token-second"],
      expiresIn: 60,
    });
    const client = makeClient(stub.fetchFn, () => nowMs);
    await Promise.all([client.listInvoices(), client.listDisputes()]);
    expect(stub.tokenCalls()).toBe(1);
    // Past the 60-second lifetime (and the 30-second safety buffer), the
    // next parallel burst must fetch — and must fetch only once.
    nowMs += 61_000;
    await Promise.all([client.listInvoices(), client.listDisputes(), client.listPayouts()]);
    expect(stub.tokenCalls()).toBe(2);
    expect(stub.authorizations.slice(-3)).toEqual(["token-second", "token-second", "token-second"]);
  });

  it("README documents the token-fetch coalescing", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("share a single in-flight token fetch");
    expect(readme).toContain("a failed shared fetch is never retained");
  });
});
