import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LLM_REQUEST_TIMEOUT_MS,
  LlmExtractionError,
  OpenAiCompatibleLlmAdapter,
} from "@/lib/agent";
import {
  PayPalError,
  SANDBOX_REQUEST_TIMEOUT_MS,
  SandboxPayPalClient,
  type FetchFn,
} from "@/lib/paypal";

/**
 * Outbound timeout config hygiene — a fractional `timeoutMs` is
 * floored to the whole milliseconds it admits, on BOTH adapters.
 * The runtime's abort timer enforces an integer delay (a 10.9 ms
 * timer fires at 10 ms; a sub-1 delay is clamped to ~1 ms), but
 * both adapters' timeout refusals name the configured value — so
 * a fractional value such as 30.9 was enforced as 30 ms while the
 * refusal named a "30.9 ms" timeout that can never be the one
 * truly enforced, and a sub-1 fraction such as 0.5 was enforced
 * as ~1 ms while naming half a millisecond: every call "timed
 * out", the same config-typo trap the non-positive fallback
 * closed for 0. The fix mirrors the response-size flooring in
 * the same constructors: floor when the floor admits at least
 * one whole millisecond, otherwise fall back to the named
 * default (`SANDBOX_REQUEST_TIMEOUT_MS` /
 * `LLM_REQUEST_TIMEOUT_MS`). Exercised against stub fetches with
 * FAKE credentials and a FAKE key; no network, no real
 * credentials.
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

/**
 * Token answers at once; the API path answers after ~25 ms and —
 * like a real fetch — rejects with an abort error if the caller's
 * signal has fired by then.
 */
function tokenThenDelayedFetch(): FetchFn {
  return async (url, init) => {
    if (new URL(url).pathname === "/v1/oauth2/token") {
      return json(200, { access_token: "fake-token", expires_in: 3600 });
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (init?.signal?.aborted) throw abortError();
    return json(200, { items: [] });
  };
}

function makeSandboxClient(fetchFn: FetchFn, timeoutMs: number): SandboxPayPalClient {
  return new SandboxPayPalClient({
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    fetchFn,
    timeoutMs,
  });
}

const LLM_CONFIG = { apiKey: "fake-key", baseUrl: "https://llm.example/v1", model: "fake-model" };

const GOOD_CONTENT = JSON.stringify({
  steps: [{ type: "draft_payout", recipientName: "Marco", amount: 200, currency: "USD" }],
});

/** An LLM success stub answering after ~25 ms, honouring the abort signal. */
function llmDelayedSuccessFetch() {
  return async (_url: string, init: Record<string, unknown>) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const signal = init.signal as AbortSignal | undefined;
    if (signal?.aborted) throw abortError();
    const envelope = { choices: [{ message: { content: GOOD_CONTENT } }] };
    return {
      ok: true,
      status: 200,
      json: async () => envelope,
      text: async () => JSON.stringify(envelope),
    };
  };
}

/** An LLM fetch that never answers — it rejects only on abort. */
function llmHangingFetch() {
  return async (_url: string, init: Record<string, unknown>) =>
    new Promise((_resolve, reject) => {
      const signal = init.signal as AbortSignal | undefined;
      if (!signal) {
        reject(new Error("expected an AbortSignal on the request"));
        return;
      }
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    }) as never;
}

describe("outbound timeout config hygiene (fractional timeoutMs, both adapters)", () => {
  it("pins both default bounds at 10 seconds", () => {
    expect(SANDBOX_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(LLM_REQUEST_TIMEOUT_MS).toBe(10_000);
  });

  it("sandbox: a fractional timeoutMs is floored and the 504 names the floored integer", async () => {
    const seen: string[] = [];
    const client = makeSandboxClient(tokenThenHangFetch(seen), 30.9);
    const err = await client.listDisputes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    const paypalErr = err as PayPalError;
    expect(paypalErr.status).toBe(504);
    expect(paypalErr.name_).toBe("REQUEST_TIMEOUT");
    expect(paypalErr.message).toContain("timed out after 30 ms");
    expect(paypalErr.message).not.toContain("30.9");
  });

  it("sandbox: a sub-1 fractional timeoutMs falls back to the default, so a slow-but-fine call completes", async () => {
    const client = makeSandboxClient(tokenThenDelayedFetch(), 0.5);
    await expect(client.listDisputes()).resolves.toEqual([]);
  });

  it("sandbox: a valid integer timeoutMs is honoured exactly in the 504 message", async () => {
    const seen: string[] = [];
    const client = makeSandboxClient(tokenThenHangFetch(seen), 40);
    const err = await client.listDisputes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).message).toContain("timed out after 40 ms");
  });

  it("LLM: a fractional timeoutMs is floored and the timeout error names the floored integer", async () => {
    const adapter = new OpenAiCompatibleLlmAdapter(
      { ...LLM_CONFIG, timeoutMs: 30.9 },
      { fetchFn: llmHangingFetch() },
    );
    const err = await adapter.extract("Pay Marco $200").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmExtractionError);
    expect((err as Error).message).toContain("timed out after 30 ms");
    expect((err as Error).message).not.toContain("30.9");
  });

  it("LLM: a sub-1 fractional timeoutMs falls back to the default, so a slow-but-fine call completes", async () => {
    const adapter = new OpenAiCompatibleLlmAdapter(
      { ...LLM_CONFIG, timeoutMs: 0.5 },
      { fetchFn: llmDelayedSuccessFetch() },
    );
    const extraction = await adapter.extract("Pay Marco $200");
    expect(extraction.steps).toHaveLength(1);
    expect(extraction.steps[0]).toMatchObject({ type: "draft_payout", amount: "200.00" });
  });

  it("LLM: a valid integer timeoutMs is honoured exactly in the timeout message", async () => {
    const adapter = new OpenAiCompatibleLlmAdapter(
      { ...LLM_CONFIG, timeoutMs: 40 },
      { fetchFn: llmHangingFetch() },
    );
    const err = await adapter.extract("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmExtractionError);
    expect((err as Error).message).toContain("timed out after 40 ms");
  });

  it("is documented in the README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("floored to the whole milliseconds it admits");
  });
});
