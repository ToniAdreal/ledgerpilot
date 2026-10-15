import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  LLM_MAX_RESPONSE_BYTES,
  LlmExtractionError,
  OpenAiCompatibleLlmAdapter,
} from "@/lib/agent";
import {
  PayPalError,
  SANDBOX_MAX_RESPONSE_BYTES,
  SandboxPayPalClient,
  type FetchFn,
} from "@/lib/paypal";

/**
 * Outbound response-size config hygiene — both outbound adapters'
 * `maxResponseBytes` bounds honour a positive integer exactly, and
 * sanitise a fractional one instead of driving the byte-length
 * comparison raw, mirroring the rate limiter's floored fractional
 * limit (`api-rate-limit-limit-config.test.ts`). Until this
 * flooring existed, a fractional limit such as 1024.9 was enforced
 * as 1024 whole bytes — a body length is an integer — while the
 * refusal named "1024.9-byte limit", a limit that can never be the
 * one truly enforced; and a sub-1 fraction such as 0.5 refused
 * every non-empty body while naming half a byte. A fractional
 * value is now floored to the whole bytes it admits, and a value
 * whose floor admits no whole byte falls back to the default
 * bound, like the non-positive values before it. Exercised
 * against stub fetches with FAKE credentials — no network, no
 * real account, no real LLM key.
 */

function jsonResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { "content-type": "application/json" } });
}

const TOKEN_BODY = JSON.stringify({ access_token: "fake-token", token_type: "Bearer", expires_in: 32400 });

function stubFetch(apiText: string): FetchFn {
  return async (url) => {
    const path = new URL(url).pathname;
    if (path === "/v1/oauth2/token") return jsonResponse(200, TOKEN_BODY);
    return jsonResponse(200, apiText);
  };
}

function makeSandboxClient(apiText: string, maxResponseBytes?: number): SandboxPayPalClient {
  return new SandboxPayPalClient({
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    fetchFn: stubFetch(apiText),
    ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
  });
}

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

/** A disputes body of exactly `target` bytes. */
function disputesBodyOf(target: number): string {
  const base = JSON.stringify({ items: [], pad: "" });
  const body = JSON.stringify({ items: [], pad: "x".repeat(target - byteLength(base)) });
  expect(byteLength(body)).toBe(target);
  return body;
}

const DISPUTES_BODY = JSON.stringify({ items: [] });

describe("sandbox response-size config hygiene", () => {
  it("a fractional limit is floored: the refusal names the whole-byte limit truly enforced", async () => {
    const client = makeSandboxClient(disputesBodyOf(2_000), 1_024.9);
    const err = await client.listDisputes().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).name_).toBe("RESPONSE_TOO_LARGE");
    expect((err as PayPalError).message).toContain("1024-byte limit");
    expect((err as PayPalError).message).not.toContain("1024.9");
  });

  it("the floored limit is the exact enforced limit: a body at the floor is accepted, one byte over is refused", async () => {
    await expect(makeSandboxClient(disputesBodyOf(200), 200.9).listDisputes()).resolves.toEqual([]);
    const err = await makeSandboxClient(disputesBodyOf(201), 200.9)
      .listDisputes()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).message).toContain("200-byte limit");
  });

  it("a sub-1 fractional limit falls back to the default bound instead of refusing every body", async () => {
    expect(SANDBOX_MAX_RESPONSE_BYTES).toBe(4_194_304);
    await expect(makeSandboxClient(DISPUTES_BODY, 0.5).listDisputes()).resolves.toEqual([]);
  });

  it("still honours a valid integer limit exactly", async () => {
    await expect(makeSandboxClient(disputesBodyOf(200), 200).listDisputes()).resolves.toEqual([]);
    const err = await makeSandboxClient(disputesBodyOf(201), 200)
      .listDisputes()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).message).toContain("200-byte limit");
  });
});

const GOOD_EXTRACTION = JSON.stringify({
  steps: [
    { type: "create_invoice", recipientName: "Ana", amount: 450, currency: "USD", description: "brand work" },
  ],
});
const envelope = (content: string) => JSON.stringify({ choices: [{ message: { content } }] });

/** An LLM envelope response text of exactly `target` bytes (trailing spaces are valid JSON padding). */
function llmBodyOf(target: number): string {
  const base = envelope(GOOD_EXTRACTION);
  const body = base + " ".repeat(target - byteLength(base));
  expect(byteLength(body)).toBe(target);
  return body;
}

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

describe("LLM response-size config hygiene", () => {
  it("a fractional limit is floored: the refusal names the whole-byte limit truly enforced", async () => {
    const adapter = makeLlmAdapter(llmBodyOf(2_000), 1_024.9);
    const err = await adapter.extract("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmExtractionError);
    expect((err as Error).message).toContain("1024-byte limit");
    expect((err as Error).message).not.toContain("1024.9");
  });

  it("the floored limit is the exact enforced limit: a body at the floor is accepted, one byte over is refused", async () => {
    const accepted = await makeLlmAdapter(llmBodyOf(200), 200.9).extract("x");
    expect(accepted.steps).toHaveLength(1);
    const err = await makeLlmAdapter(llmBodyOf(201), 200.9)
      .extract("x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmExtractionError);
    expect((err as Error).message).toContain("200-byte limit");
  });

  it("a sub-1 fractional limit falls back to the default bound instead of refusing every body", async () => {
    expect(LLM_MAX_RESPONSE_BYTES).toBe(262_144);
    const extraction = await makeLlmAdapter(envelope(GOOD_EXTRACTION), 0.5).extract("x");
    expect(extraction.steps).toHaveLength(1);
  });

  it("still honours a valid integer limit exactly", async () => {
    const accepted = await makeLlmAdapter(llmBodyOf(200), 200).extract("x");
    expect(accepted.steps).toHaveLength(1);
    const err = await makeLlmAdapter(llmBodyOf(201), 200)
      .extract("x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmExtractionError);
    expect((err as Error).message).toContain("200-byte limit");
  });
});

describe("documentation", () => {
  it("README documents the floored fractional response-size limits", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("a fractional `maxResponseBytes` is floored");
  });
});
