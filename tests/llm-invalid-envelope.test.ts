import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  BriefParseError,
  LlmExtractionError,
  OpenAiCompatibleLlmAdapter,
  parseBriefWithFallback,
} from "@/lib/agent";

/**
 * LLM invalid success envelope tests — a 200 response from the
 * optional LLM endpoint whose JSON body is an object, but whose
 * first choice entry is not an object (`choices: [null]`, from a
 * proxy or a non-conforming OpenAI-compatible endpoint), is
 * refused as an `LlmExtractionError` ("LLM choice must be an
 * object"), like every other envelope malformation. Until this
 * check existed, the choice entry was dereferenced directly, so
 * that one shape escaped `extract()` as a raw `TypeError` —
 * breaking the adapter's one-error-shape contract for direct
 * callers (`parseBriefWithFallback` catches every failure either
 * way, so its fallback honesty was never affected). The refusal
 * message is a fixed string: no part of the response body, and
 * no credential, is carried. The neighbouring envelope shapes
 * (non-object body, missing/empty choices, non-object message,
 * non-string content, a valid envelope) keep their exact
 * previous behaviour. Exercised against stub fetches with a
 * FAKE key; no network, no real credentials.
 */

const MARKER = "SECRET-MARKER-envelope-detail";
const CONFIG = { apiKey: "fake-key", baseUrl: "https://llm.example/v1", model: "fake-model" };

function stubFetchWithBody(body: unknown) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
}

function adapterFor(body: unknown): OpenAiCompatibleLlmAdapter {
  return new OpenAiCompatibleLlmAdapter(CONFIG, { fetchFn: stubFetchWithBody(body) as never });
}

function expectExtractionError(err: unknown, message: string): void {
  expect(err).toBeInstanceOf(LlmExtractionError);
  expect(err).not.toBeInstanceOf(TypeError);
  expect((err as Error).message).toBe(message);
  expect((err as Error).message).not.toContain(MARKER);
  expect((err as Error).message).not.toContain("fake-key");
}

describe("LLM invalid success envelope", () => {
  it("refuses a null choice entry as an LlmExtractionError, never a TypeError", async () => {
    const err = await adapterFor({ choices: [null], detail: MARKER })
      .extract("x")
      .catch((e: unknown) => e);
    expectExtractionError(err, "LLM choice must be an object");
  });

  it.each([
    ["string", "a choice"],
    ["number", 42],
    ["boolean", true],
    ["array", []],
  ])("refuses a %s choice entry with the same fixed message", async (_label, entry) => {
    const err = await adapterFor({ choices: [entry] }).extract("x").catch((e: unknown) => e);
    expectExtractionError(err, "LLM choice must be an object");
  });

  it.each([
    ["null message", { choices: [{ message: null }] }],
    ["missing message", { choices: [{}] }],
    ["scalar message", { choices: [{ message: "text" }] }],
  ])("keeps the message-shape refusal for %s", async (_label, body) => {
    const err = await adapterFor(body).extract("x").catch((e: unknown) => e);
    expectExtractionError(err, "LLM choice message must be an object");
  });

  it("keeps the no-text-content refusal for a message without string content", async () => {
    const err = await adapterFor({ choices: [{ message: { content: 42 } }] })
      .extract("x")
      .catch((e: unknown) => e);
    expectExtractionError(err, "LLM choice has no text content");
  });

  it.each([
    ["scalar body", 42],
    ["array body", []],
    ["null body", null],
  ])("keeps the response-shape refusal for a %s", async (_label, body) => {
    const err = await adapterFor(body).extract("x").catch((e: unknown) => e);
    expectExtractionError(err, "LLM response must be an object");
  });

  it.each([
    ["missing choices", {}],
    ["empty choices", { choices: [] }],
    ["non-array choices", { choices: "none" }],
  ])("keeps the no-choices refusal for %s", async (_label, body) => {
    const err = await adapterFor(body).extract("x").catch((e: unknown) => e);
    expectExtractionError(err, "LLM response has no choices");
  });

  it("keeps the fallback honesty: a malformed envelope surfaces the parser's original error", async () => {
    const adapter = adapterFor({ choices: [null], detail: MARKER });
    const err = await parseBriefWithFallback("Blorp zibber flarn", { llm: adapter }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BriefParseError);
    expect(err).not.toBeInstanceOf(LlmExtractionError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).not.toContain(MARKER);
  });

  it("still extracts from a valid envelope (the check does not over-tighten)", async () => {
    const extraction = JSON.stringify({
      steps: [{ type: "create_order", amount: 75, currency: "USD", description: "logo pack" }],
    });
    const out = await adapterFor({ choices: [{ message: { content: extraction } }] }).extract("Sell a logo pack");
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]).toMatchObject({ type: "create_order", amount: "75.00" });
  });

  it("is documented in the README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("LLM choice must be an object");
  });
});
