import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PayPalError,
  SANDBOX_REQUEST_TIMEOUT_MS,
  SandboxPayPalClient,
  type FetchFn,
} from "@/lib/paypal";

/**
 * Sandbox transport timeout tests — every outbound PayPal call is
 * bounded, exercised against stub fetches with FAKE credentials.
 * No network, no real PayPal account. The hanging stub resolves
 * never; it rejects only when the caller's AbortSignal fires,
 * exactly as the real fetch does.
 */

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

/** A fetch that never answers — it rejects only on abort. */
function hangingFetch(seen: string[]): FetchFn {
  return (url, init) => {
    seen.push(url);
    return new Promise<Response>((_resolve, reject) => {
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
  };
}

/** Token answers at once; every API path hangs. */
function tokenThenHangFetch(seen: string[]): FetchFn {
  const hang = hangingFetch(seen);
  return (url, init) => {
    if (new URL(url).pathname === "/v1/oauth2/token") {
      seen.push(url);
      return Promise.resolve(json(200, { access_token: "fake-token", expires_in: 3600 }));
    }
    return hang(url, init);
  };
}

function makeClient(fetchFn: FetchFn, timeoutMs?: number): SandboxPayPalClient {
  return new SandboxPayPalClient({
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    fetchFn,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

describe("sandbox request timeout", () => {
  it("defaults to a 10-second bound", () => {
    expect(SANDBOX_REQUEST_TIMEOUT_MS).toBe(10_000);
  });

  it("passes an AbortSignal on every outbound call and completes inside the bound", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchFn: FetchFn = async (url, init) => {
      signals.push(init?.signal);
      if (new URL(url).pathname === "/v1/oauth2/token") {
        return json(200, { access_token: "fake-token", expires_in: 3600 });
      }
      return json(200, { items: [] });
    };
    const client = makeClient(fetchFn, 1_000);
    await expect(client.listDisputes()).resolves.toEqual([]);
    expect(signals).toHaveLength(2);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    }
  });

  it("translates a hanging API call into a 504 REQUEST_TIMEOUT naming method and path", async () => {
    const seen: string[] = [];
    const client = makeClient(tokenThenHangFetch(seen), 20);
    const err = await client.listDisputes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    const paypalErr = err as PayPalError;
    expect(paypalErr.status).toBe(504);
    expect(paypalErr.name_).toBe("REQUEST_TIMEOUT");
    expect(paypalErr.message).toContain("timed out after 20 ms");
    expect(paypalErr.message).toContain("GET /v1/customer/disputes");
    // The label names the path only — no query string, no credential.
    expect(paypalErr.message).not.toContain("page_size");
    expect(paypalErr.message).not.toContain("fake-client-secret");
  });

  it("bounds the OAuth token fetch itself, before any API call is attempted", async () => {
    const seen: string[] = [];
    const client = makeClient(hangingFetch(seen), 20);
    const err = await client.listDisputes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    const paypalErr = err as PayPalError;
    expect(paypalErr.status).toBe(504);
    expect(paypalErr.name_).toBe("REQUEST_TIMEOUT");
    expect(paypalErr.message).toContain("POST /v1/oauth2/token");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/v1/oauth2/token");
  });

  it("lets a slow-but-inside-the-bound call succeed", async () => {
    const fetchFn: FetchFn = async (url) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (new URL(url).pathname === "/v1/oauth2/token") {
        return json(200, { access_token: "fake-token", expires_in: 3600 });
      }
      return json(200, { items: [] });
    };
    const client = makeClient(fetchFn, 1_000);
    await expect(client.listDisputes()).resolves.toEqual([]);
  });

  it("never reports a non-timeout fetch failure as a timeout (the connection-failure translation owns it)", async () => {
    // This suite originally pinned non-timeout fetch failures as
    // rethrown untouched. That scoping was superseded by the
    // connection-failure chunk: the raw transport error escaped
    // every route layer that translates only `PayPalError` as an
    // opaque HTML 500 (see src/lib/paypal/sandbox.ts header). The
    // division this suite still pins: a connection failure is
    // translated by that chunk as 502 CONNECTION_FAILED — it is
    // never dressed up as this bound's 504 REQUEST_TIMEOUT. The
    // full behaviour is pinned in sandbox-connection-failure.test.ts.
    const networkError = new TypeError("fetch failed: connection refused");
    const fetchFn: FetchFn = async () => {
      throw networkError;
    };
    const client = makeClient(fetchFn, 1_000);
    const err = await client.listDisputes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    const paypalErr = err as PayPalError;
    expect(paypalErr.status).toBe(502);
    expect(paypalErr.name_).toBe("CONNECTION_FAILED");
    expect(paypalErr.name_).not.toBe("REQUEST_TIMEOUT");
    expect(err).not.toBe(networkError);
  });

  it("falls back to the default bound for a non-positive timeout value", async () => {
    // With timeoutMs: 0 honoured literally, the 25 ms stub below
    // could never complete; the fallback to the 10 s default lets it.
    const fetchFn: FetchFn = async (url) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (new URL(url).pathname === "/v1/oauth2/token") {
        return json(200, { access_token: "fake-token", expires_in: 3600 });
      }
      return json(200, { items: [] });
    };
    const client = makeClient(fetchFn, 0);
    await expect(client.listDisputes()).resolves.toEqual([]);
  });

  it("is documented in the README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("SANDBOX_REQUEST_TIMEOUT_MS");
    expect(readme).toContain("REQUEST_TIMEOUT");
  });
});
