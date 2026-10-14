import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  BriefParseError,
  LLM_MAX_RESPONSE_BYTES,
  LlmExtractionError,
  OpenAiCompatibleLlmAdapter,
  parseBriefWithFallback,
} from "@/lib/agent";
import {
  PayPalError,
  SANDBOX_MAX_RESPONSE_BYTES,
  SandboxPayPalClient,
  type FetchFn,
} from "@/lib/paypal";

/**
 * Outbound response-size tests — the timeout bounds how long an
 * outbound call may take; this bound limits how much it may return.
 * Both adapters (sandbox PayPal + optional LLM) measure the body in
 * UTF-8 bytes before parsing and refuse an oversized body naming
 * the limit only. Exercised against stub fetches with FAKE
 * credentials — no network, no real account, no real LLM key.
 */

function jsonResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { "content-type": "application/json" } });
}

const TOKEN_BODY = JSON.stringify({ access_token: "fake-token", expires_in: 3600 });

/** Token answers small; every API path answers `apiText`. */
function stubFetch(apiText: string, calls?: string[]): FetchFn {
  return async (url) => {
    const path = new URL(url).pathname;
    calls?.push(path);
    if (path === "/v1/oauth2/token") return jsonResponse(200, TOKEN_BODY);
    return jsonResponse(200, apiText);
  };
}

function makeSandboxClient(fetchFn: FetchFn, maxResponseBytes?: number): SandboxPayPalClient {
  return new SandboxPayPalClient({
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    fetchFn,
    ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
  });
}

const DISPUTES_BODY = JSON.stringify({ items: [] });
const PAD_MARKER = "PAD-MARKER-9f3c";
const paddedDisputes = (bytes: number) =>
  JSON.stringify({ items: [], pad: PAD_MARKER + "x".repeat(bytes) });

describe("sandbox response-size bound", () => {
  it("defaults to a 4 MiB bound", () => {
    expect(SANDBOX_MAX_RESPONSE_BYTES).toBe(4_194_304);
  });

  it("refuses an oversized API response before parsing, naming the limit only", async () => {
    const client = makeSandboxClient(stubFetch(paddedDisputes(2_000)), 1_024);
    const err = await client.listDisputes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).status).toBe(502);
    expect((err as PayPalError).name_).toBe("RESPONSE_TOO_LARGE");
    expect((err as PayPalError).message).toContain("1024");
    expect((err as PayPalError).message).not.toContain(PAD_MARKER);
  });

  it("refuses an oversized OAuth token response and makes no API call", async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      calls.push(new URL(url).pathname);
      return jsonResponse(200, paddedDisputes(2_000));
    };
    const client = makeSandboxClient(fetchFn, 1_024);
    const err = await client.listDisputes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).name_).toBe("RESPONSE_TOO_LARGE");
    expect((err as PayPalError).status).toBe(502);
    expect(calls).toEqual(["/v1/oauth2/token"]);
  });

  it("accepts response bodies at or under the configured limit", async () => {
    // The limit applies to every response, the OAuth token included:
    // the cap here is exactly the token body's size, and the smaller
    // disputes body is under it.
    const cap = new TextEncoder().encode(TOKEN_BODY).byteLength;
    const client = makeSandboxClient(stubFetch(DISPUTES_BODY), cap);
    await expect(client.listDisputes()).resolves.toEqual([]);
  });

  it("refuses a response body one byte over the configured limit", async () => {
    const body = paddedDisputes(200);
    const cap = new TextEncoder().encode(body).byteLength - 1;
    // cap still exceeds the token body, so the refusal is the API body's.
    expect(cap).toBeGreaterThan(new TextEncoder().encode(TOKEN_BODY).byteLength);
    const client = makeSandboxClient(stubFetch(body), cap);
    const err = await client.listDisputes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).name_).toBe("RESPONSE_TOO_LARGE");
  });

  it("refuses an oversized error body for its size instead of mapping it", async () => {
    const fetchFn: FetchFn = async (url) => {
      if (new URL(url).pathname === "/v1/oauth2/token") return jsonResponse(200, TOKEN_BODY);
      return jsonResponse(500, paddedDisputes(2_000));
    };
    const client = makeSandboxClient(fetchFn, 1_024);
    const err = await client.listDisputes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).name_).toBe("RESPONSE_TOO_LARGE");
    expect((err as PayPalError).status).toBe(502);
  });

  it("falls back to the default bound for a non-positive limit", async () => {
    const client = makeSandboxClient(stubFetch(DISPUTES_BODY), 0);
    await expect(client.listDisputes()).resolves.toEqual([]);
  });
});

const GOOD_EXTRACTION = JSON.stringify({
  steps: [
    { type: "create_invoice", recipientName: "Ana", amount: 450, currency: "USD", description: "brand work" },
  ],
});
const envelope = (content: string) => JSON.stringify({ choices: [{ message: { content } }] });

function makeLlmAdapter(responseText: string, maxResponseBytes?: number) {
  const fetchFn = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => JSON.parse(responseText),
    text: async () => responseText,
  }));
  return new OpenAiCompatibleLlmAdapter(
    {
      apiKey: "fake-key",
      baseUrl: "https://llm.example/v1",
      model: "m1",
      ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
    },
    { fetchFn: fetchFn as never },
  );
}

describe("LLM response-size bound", () => {
  it("defaults to a 256 KiB bound", () => {
    expect(LLM_MAX_RESPONSE_BYTES).toBe(262_144);
  });

  it("refuses an oversized LLM response before parsing, naming the limit only", async () => {
    const adapter = makeLlmAdapter(envelope(GOOD_EXTRACTION) + " ".repeat(5_000), 1_024);
    const err = await adapter.extract("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmExtractionError);
    expect((err as Error).message).toContain("1024");
    expect((err as Error).message).not.toContain("brand work");
  });

  it("accepts a response under the bound and extracts as before", async () => {
    const adapter = makeLlmAdapter(envelope(GOOD_EXTRACTION), 1_024);
    const extraction = await adapter.extract("x");
    expect(extraction.steps).toHaveLength(1);
  });

  it("falls back to the default bound for a non-positive limit", async () => {
    const adapter = makeLlmAdapter(envelope(GOOD_EXTRACTION), 0);
    await expect(adapter.extract("x")).resolves.toMatchObject({ steps: [{ type: "create_invoice" }] });
  });

  it("an oversized LLM response still falls back to the deterministic parser's error", async () => {
    const llm = makeLlmAdapter(envelope(GOOD_EXTRACTION) + " ".repeat(5_000), 1_024);
    await expect(
      parseBriefWithFallback("Could you sort out the brand work billing for Ana?", { llm }),
    ).rejects.toThrow(BriefParseError);
  });
});

describe("documentation", () => {
  it("README documents both response-size bounds", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("SANDBOX_MAX_RESPONSE_BYTES");
    expect(readme).toContain("RESPONSE_TOO_LARGE");
    expect(readme).toContain("LLM_MAX_RESPONSE_BYTES");
  });
});
