import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SandboxPayPalClient, type FetchFn } from "@/lib/paypal";

/**
 * Sandbox OAuth token `expires_in` fractional hygiene — the
 * companion to the token-refresh suite's malformed-lifetime
 * cases (non-numeric / non-positive / non-finite fall back to
 * the default 3600-second lifetime).
 *
 * `expires_in` is an integer-seconds lifetime, and the token
 * cache computes its expiry on an integer-millisecond clock
 * with a 30-second validity buffer. Until this hygiene existed,
 * a fractional lifetime drove that computation raw:
 *  - 3600.9 cached the token for a fraction of a second longer
 *    than the whole seconds the response stated;
 *  - a sub-1 fraction such as 0.5 produced an expiry the
 *    cache's own 30-second validity buffer could never honour,
 *    so every API call refetched the token — the same
 *    caching-silently-off failure the non-numeric fallback
 *    closed, reached through a positive finite number.
 *
 * The behaviour pinned here: a fractional `expires_in` is
 * floored to the whole seconds it admits, a sub-1 fraction
 * falls back to the default lifetime like a non-positive
 * value, and a valid integer lifetime is honoured exactly.
 * This mirrors the floored fractional timeout and
 * response-size bounds on the same adapter.
 *
 * Exercised against stub fetches with FAKE credentials and a
 * fake token, on an injectable advancing clock. No network,
 * no real PayPal account.
 */

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeStub(expiresIn: unknown) {
  let tokenCalls = 0;
  const fetchFn: FetchFn = (url) => {
    const path = new URL(url).pathname;
    if (path === "/v1/oauth2/token") {
      tokenCalls += 1;
      return Promise.resolve(
        json(200, { access_token: "fake-token", token_type: "Bearer", expires_in: expiresIn }),
      );
    }
    // Generic successful read: an empty invoice list object.
    return Promise.resolve(json(200, { items: [] }));
  };
  return { fetchFn, tokenCalls: () => tokenCalls };
}

const T0 = Date.parse("2026-10-14T12:00:00Z");

function makeClient(expiresIn: unknown) {
  const stub = makeStub(expiresIn);
  const nowRef = { ms: T0 };
  const client = new SandboxPayPalClient({
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    webhookId: "WH-ID-1",
    fetchFn: stub.fetchFn,
    now: () => nowRef.ms,
  });
  return { client, stub, nowRef };
}

describe("sandbox OAuth token expires_in fractional hygiene", () => {
  it("floors a fractional expires_in to the whole seconds it admits (3600.9 expires as 3600)", async () => {
    const { client, stub, nowRef } = makeClient(3600.9);
    await client.listInvoices();
    expect(stub.tokenCalls()).toBe(1);
    // One millisecond before the floored expiry leaves the
    // 30-second validity buffer: still cached.
    nowRef.ms = T0 + 3_569_999;
    await client.listInvoices();
    expect(stub.tokenCalls()).toBe(1);
    // Exactly at the floored boundary (expiry == now + buffer):
    // the raw 3600.9 would still have been cached here; the
    // floored 3600 is not, so the token is refetched.
    nowRef.ms = T0 + 3_570_000;
    await client.listInvoices();
    expect(stub.tokenCalls()).toBe(2);
  });

  it("floors a fractional string expires_in the same way (\"120.9\" expires as 120)", async () => {
    const { client, stub, nowRef } = makeClient("120.9");
    await client.listInvoices();
    nowRef.ms = T0 + 89_999;
    await client.listInvoices();
    expect(stub.tokenCalls()).toBe(1);
    nowRef.ms = T0 + 90_000;
    await client.listInvoices();
    expect(stub.tokenCalls()).toBe(2);
  });

  it("treats a sub-1 fractional expires_in as the default lifetime (cache stays usable)", async () => {
    const { client, stub, nowRef } = makeClient(0.5);
    await client.listInvoices();
    nowRef.ms = T0 + 60_000;
    await client.listInvoices();
    await client.listInvoices();
    expect(stub.tokenCalls()).toBe(1);
  });

  it("honours a valid integer expires_in exactly (3600 expires as 3600)", async () => {
    const { client, stub, nowRef } = makeClient(3600);
    await client.listInvoices();
    nowRef.ms = T0 + 3_569_999;
    await client.listInvoices();
    expect(stub.tokenCalls()).toBe(1);
    nowRef.ms = T0 + 3_570_000;
    await client.listInvoices();
    expect(stub.tokenCalls()).toBe(2);
  });

  it("README documents the fractional expires_in flooring", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("A fractional `expires_in` is floored");
    expect(readme).toContain("a sub-1 fraction falls back to the same default");
  });
});
