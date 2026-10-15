import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LLM_REQUEST_TIMEOUT_MS,
  LlmExtractionError,
  OpenAiCompatibleLlmAdapter,
} from "@/lib/agent";

/**
 * LLM timeout config hygiene — the adapter's per-request timeout
 * honours a positive finite `timeoutMs` exactly, and falls back to
 * the default (`LLM_REQUEST_TIMEOUT_MS`, 10 s) for a non-positive
 * or non-finite one, mirroring the sandbox adapter's pinned
 * fallback for the same config shape and this adapter's own
 * sanitisation of `maxResponseBytes`. Until this fallback existed,
 * the raw value went straight to `setTimeout`: 0, a negative, or
 * NaN armed the abort timer for ~0 ms and Infinity overflowed to
 * ~1 ms, so a single malformed config value made EVERY LLM call
 * "time out" before any endpoint could answer — a config typo
 * dressed as a permanently unreachable endpoint. Exercised
 * against stub fetches with a FAKE key; no network, no real
 * credentials.
 */

const CONFIG = { apiKey: "fake-key", baseUrl: "https://llm.example/v1", model: "fake-model" };

const GOOD_CONTENT = JSON.stringify({
  steps: [{ type: "draft_payout", recipientName: "Marco", amount: 200, currency: "USD" }],
});

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

/**
 * A success stub that answers after ~25 ms and — like a real
 * fetch — rejects with an abort error if the caller's signal has
 * fired by then. (A stub that ignored the signal could never show
 * the pre-fix behaviour: an instantly-armed timer aborts a real
 * call, not an oblivious stub.)
 */
function delayedSuccessFetch() {
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

describe("LLM timeout config hygiene", () => {
  it("pins the default bound at 10 seconds", () => {
    expect(LLM_REQUEST_TIMEOUT_MS).toBe(10_000);
  });

  it.each([
    ["zero", 0],
    ["negative", -100],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("falls back to the default bound for a %s timeoutMs, so a slow-but-fine call completes", async (_label, timeoutMs) => {
    const adapter = new OpenAiCompatibleLlmAdapter(
      { ...CONFIG, timeoutMs },
      { fetchFn: delayedSuccessFetch() },
    );
    const extraction = await adapter.extract("Pay Marco $200");
    expect(extraction.steps).toHaveLength(1);
    expect(extraction.steps[0]).toMatchObject({ type: "draft_payout", amount: "200.00" });
  });

  it("still honours a valid small timeoutMs exactly (a hanging call times out at the configured bound)", async () => {
    const adapter = new OpenAiCompatibleLlmAdapter(
      { ...CONFIG, timeoutMs: 20 },
      {
        fetchFn: async (_url, init) =>
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
          }) as never,
      },
    );
    const err = await adapter.extract("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmExtractionError);
    expect((err as Error).message).toContain("timed out after 20 ms");
  });

  it("is documented in the README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("LLM_REQUEST_TIMEOUT_MS");
  });
});
