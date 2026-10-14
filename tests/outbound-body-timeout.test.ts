import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BriefParseError,
  LlmExtractionError,
  OpenAiCompatibleLlmAdapter,
  parseBriefWithFallback,
} from "@/lib/agent";
import {
  PayPalError,
  SandboxPayPalClient,
  type FetchFn,
} from "@/lib/paypal";

/**
 * Outbound body-read timeout tests — the per-request timeout on
 * both outbound adapters (sandbox PayPal + the optional LLM) spans
 * the response body, not just the wait for the headers. A stub
 * endpoint answers its headers at once and then never finishes its
 * body; the body read rejects only when the caller's AbortSignal
 * fires, exactly as a real fetch body stream behaves. Fake
 * credentials only; no network, no real account.
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

/** A body that never finishes: its text() rejects only on abort. */
function hangingText(signal: AbortSignal | null | undefined): () => Promise<string> {
  return () =>
    new Promise<string>((_resolve, reject) => {
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
}

/** A response whose headers arrive at once but whose body hangs. */
function hangingBodyResponse(signal: AbortSignal | null | undefined): Response {
  return {
    ok: true,
    status: 200,
    text: hangingText(signal),
    json: async () => {
      throw new Error("json() is not used by the sandbox adapter");
    },
  } as unknown as Response;
}

function tokenJson(): Response {
  return json(200, { access_token: "fake-token", expires_in: 3600 });
}

describe("sandbox body-read timeout", () => {
  it("aborts an API call whose headers arrived but whose body never finishes", async () => {
    const seen: string[] = [];
    const fetchFn: FetchFn = (url, init) => {
      seen.push(url);
      if (new URL(url).pathname === "/v1/oauth2/token") {
        return Promise.resolve(tokenJson());
      }
      return Promise.resolve(hangingBodyResponse(init?.signal));
    };
    const client = new SandboxPayPalClient({
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      fetchFn,
      timeoutMs: 20,
    });
    const err = await client.listDisputes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    const paypalErr = err as PayPalError;
    expect(paypalErr.status).toBe(504);
    expect(paypalErr.name_).toBe("REQUEST_TIMEOUT");
    expect(paypalErr.message).toContain("timed out after 20 ms");
    expect(paypalErr.message).toContain("GET /v1/customer/disputes");
    expect(paypalErr.message).not.toContain("fake-client-secret");
    expect(seen).toHaveLength(2);
  });

  it("aborts a hanging token body before any API call is attempted", async () => {
    const seen: string[] = [];
    const fetchFn: FetchFn = (url, init) => {
      seen.push(url);
      return Promise.resolve(hangingBodyResponse(init?.signal));
    };
    const client = new SandboxPayPalClient({
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      fetchFn,
      timeoutMs: 20,
    });
    const err = await client.listDisputes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    const paypalErr = err as PayPalError;
    expect(paypalErr.status).toBe(504);
    expect(paypalErr.name_).toBe("REQUEST_TIMEOUT");
    expect(paypalErr.message).toContain("POST /v1/oauth2/token");
    expect(seen).toHaveLength(1);
  });

  it("lets a slow body that finishes inside the bound succeed", async () => {
    const fetchFn: FetchFn = async (url) => {
      if (new URL(url).pathname === "/v1/oauth2/token") return tokenJson();
      await new Promise((resolve) => setTimeout(resolve, 25));
      return json(200, { items: [] });
    };
    const client = new SandboxPayPalClient({
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      fetchFn,
      timeoutMs: 1_000,
    });
    await expect(client.listDisputes()).resolves.toEqual([]);
  });
});

describe("LLM body-read timeout", () => {
  const config = { apiKey: "fake-key", baseUrl: "https://llm.example/v1", model: "fake-model" };
  const envelope = {
    choices: [
      {
        message: {
          content: JSON.stringify({
            steps: [{ type: "create_order", amount: 25, currency: "USD", description: "Logo pack" }],
          }),
        },
      },
    ],
  };

  it("aborts an LLM call whose headers arrived but whose body never finishes", async () => {
    const adapter = new OpenAiCompatibleLlmAdapter(
      { ...config, timeoutMs: 20 },
      {
        fetchFn: async (_url, init) => ({
          ok: true,
          status: 200,
          json: async () => envelope,
          text: hangingText(init.signal as AbortSignal | undefined),
        }),
      },
    );
    const err = await adapter.extract("Sell a logo pack somehow").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmExtractionError);
    expect((err as Error).message).toContain("timed out after 20 ms");
  });

  it("lets a slow LLM body that finishes inside the bound extract as before", async () => {
    const adapter = new OpenAiCompatibleLlmAdapter(
      { ...config, timeoutMs: 1_000 },
      {
        fetchFn: async () => ({
          ok: true,
          status: 200,
          json: async () => envelope,
          text: async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return JSON.stringify(envelope);
          },
        }),
      },
    );
    const extraction = await adapter.extract("Sell a logo pack somehow");
    expect(extraction.steps).toHaveLength(1);
    expect(extraction.steps[0].type).toBe("create_order");
  });

  it("keeps the fallback honesty: a body-read timeout surfaces the parser's original error", async () => {
    const adapter = new OpenAiCompatibleLlmAdapter(
      { ...config, timeoutMs: 20 },
      {
        fetchFn: async (_url, init) => ({
          ok: true,
          status: 200,
          json: async () => envelope,
          text: hangingText(init.signal as AbortSignal | undefined),
        }),
      },
    );
    const err = await parseBriefWithFallback("Blorp zibber flarn", { llm: adapter }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BriefParseError);
    expect(err).not.toBeInstanceOf(LlmExtractionError);
  });

  it("is documented in the README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("spans the response body");
  });
});
