import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LedgerStore, handleWebhookEvent } from "@/lib/agent";
import {
  PayPalError,
  SANDBOX_MAX_RESPONSE_BYTES,
  SandboxPayPalClient,
  type FetchFn,
} from "@/lib/paypal";
import type { WebhookEvent } from "@/lib/types";

/**
 * Sandbox connection failure tests — a PayPal call that gets NO
 * response at all (refused connection, DNS failure, reset
 * mid-body) is translated at the adapter's one transport choke
 * point (`fetchAndRead`) into a `PayPalError` of status 502 and
 * name `CONNECTION_FAILED` naming the request (method + path)
 * only. Exercised against stub fetches with FAKE credentials.
 * No network, no real PayPal account.
 *
 * This supersedes the sandbox timeout suite's original pin
 * (non-timeout fetch failures rethrown untouched): the raw
 * transport error escaped every route layer that translates
 * only `PayPalError` as the framework's opaque HTML 500, while
 * the webhook handler already treated any adapter throw as
 * verification-unavailable. The timeout suite now pins the
 * division instead — a connection failure is never a 504
 * `REQUEST_TIMEOUT`.
 */

const MARKER = "SECRET-MARKER-transport-detail";
const MARCO = { name: "Marco", email_address: "marco@example.com" };

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tokenJson(): Response {
  return json(200, { access_token: "fake-token", expires_in: 3600 });
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

/** A fetch that fails at the transport layer, before any response. */
function refusingFetch(seen: string[]): FetchFn {
  return (url) => {
    seen.push(url);
    return Promise.reject(new TypeError(`fetch failed: ${MARKER}`));
  };
}

/** Token answers at once; every API path refuses the connection. */
function tokenThenRefuseFetch(seen: string[]): FetchFn {
  const refuse = refusingFetch(seen);
  return (url, init) => {
    if (new URL(url).pathname === "/v1/oauth2/token") {
      seen.push(url);
      return Promise.resolve(tokenJson());
    }
    return refuse(url, init);
  };
}

function makeClient(fetchFn: FetchFn, extra: { timeoutMs?: number; webhookId?: string } = {}): SandboxPayPalClient {
  return new SandboxPayPalClient({
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    fetchFn,
    ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
    ...(extra.webhookId !== undefined ? { webhookId: extra.webhookId } : {}),
  });
}

function expectConnectionFailed(err: unknown, label: string): void {
  expect(err).toBeInstanceOf(PayPalError);
  const paypalErr = err as PayPalError;
  expect(paypalErr.status).toBe(502);
  expect(paypalErr.name_).toBe("CONNECTION_FAILED");
  expect(paypalErr.message).toContain("failed before a response was received");
  expect(paypalErr.message).toContain(label);
  // The transport error's own text is never carried — it can
  // embed the full request URL.
  expect(paypalErr.message).not.toContain(MARKER);
  expect(paypalErr.message).not.toContain("fetch failed");
  expect(paypalErr.message).not.toContain("fake-client-secret");
}

describe("sandbox connection failure", () => {
  it("translates a refused OAuth token fetch and attempts no API call", async () => {
    const seen: string[] = [];
    const client = makeClient(refusingFetch(seen));
    const err = await client.listDisputes().catch((e: unknown) => e);
    expectConnectionFailed(err, "POST /v1/oauth2/token");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/v1/oauth2/token");
  });

  it("translates a refused API read, naming method and path", async () => {
    const seen: string[] = [];
    const client = makeClient(tokenThenRefuseFetch(seen));
    const err = await client.listDisputes().catch((e: unknown) => e);
    expectConnectionFailed(err, "GET /v1/customer/disputes");
    expect(seen).toHaveLength(2);
  });

  it("translates a refused mutating call, naming the payout path", async () => {
    const seen: string[] = [];
    const client = makeClient(tokenThenRefuseFetch(seen));
    const err = await client
      .createPayout({
        items: [{ recipient: MARCO, amount: { currency_code: "USD", value: "200.00" }, note: "Contractor share" }],
      })
      .catch((e: unknown) => e);
    expectConnectionFailed(err, "POST /v1/payments/payouts");
  });

  it("translates a body read that fails mid-response", async () => {
    const brokenBody = {
      ok: true,
      status: 200,
      text: async () => {
        throw new Error(`stream reset: ${MARKER}`);
      },
      json: async () => {
        throw new Error("json() is not used by the sandbox adapter");
      },
    } as unknown as Response;
    const fetchFn: FetchFn = (url) => {
      if (new URL(url).pathname === "/v1/oauth2/token") return Promise.resolve(tokenJson());
      return Promise.resolve(brokenBody);
    };
    const client = makeClient(fetchFn);
    const err = await client.listDisputes().catch((e: unknown) => e);
    expectConnectionFailed(err, "GET /v1/customer/disputes");
  });

  it("lets an already-PayPalError failure keep its own shape (oversized body stays RESPONSE_TOO_LARGE)", async () => {
    const fetchFn: FetchFn = (url) => {
      if (new URL(url).pathname === "/v1/oauth2/token") return Promise.resolve(tokenJson());
      return Promise.resolve(
        new Response("x".repeat(SANDBOX_MAX_RESPONSE_BYTES + 1), { status: 200 }),
      );
    };
    const client = makeClient(fetchFn);
    const err = await client.listDisputes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    const paypalErr = err as PayPalError;
    expect(paypalErr.status).toBe(502);
    expect(paypalErr.name_).toBe("RESPONSE_TOO_LARGE");
    expect(paypalErr.name_).not.toBe("CONNECTION_FAILED");
  });

  it("keeps the timer's precedence: a hanging call is the 504 timeout, never a 502", async () => {
    const hangingFetch: FetchFn = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("expected an AbortSignal on the request"));
          return;
        }
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    const client = makeClient(hangingFetch, { timeoutMs: 20 });
    const err = await client.listDisputes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    const paypalErr = err as PayPalError;
    expect(paypalErr.status).toBe(504);
    expect(paypalErr.name_).toBe("REQUEST_TIMEOUT");
    expect(paypalErr.name_).not.toBe("CONNECTION_FAILED");
  });

  it("surfaces in the webhook handler as verification_unavailable, never a rejection", async () => {
    const store = new LedgerStore();
    const client = makeClient(refusingFetch([]), { webhookId: "WH-FAKE-ID" });
    const event: WebhookEvent = {
      id: "WH-CONN-1",
      create_time: "2026-10-10T12:00:00Z",
      resource_type: "capture",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      summary: "Payment capture completed",
      resource: { id: "CAP-1" },
      event_version: "1.0",
      resource_version: "2.0",
    };
    const headers = {
      "paypal-transmission-id": "trans-conn-1",
      "paypal-transmission-sig": "sig",
      "paypal-transmission-time": "2026-10-10T12:00:00Z",
      "paypal-cert-url": "https://api.sandbox.paypal.com/certs/fake.pem",
      "paypal-auth-algo": "SHA256withRSA",
    };
    const result = await handleWebhookEvent({ store, client, headers, event });
    expect(result.outcome).toBe("verification_unavailable");
    expect(result.verificationError).toContain("failed before a response was received");
    expect(store.hasProcessedEvent(event.id)).toBe(false);
    expect(result.resumed).toHaveLength(0);
  });

  it("is documented in the README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("CONNECTION_FAILED");
  });
});
