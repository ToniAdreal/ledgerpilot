import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BriefParseError,
  LlmExtractionError,
  OpenAiCompatibleLlmAdapter,
  parseBriefWithFallback,
} from "@/lib/agent";

/**
 * LLM connection failure tests — a call to the optional LLM endpoint
 * that gets NO complete response (refused connection, DNS failure,
 * reset before or during the body) is translated into a fixed
 * `LlmExtractionError` message, never the transport error's own
 * text. This mirrors the sandbox adapter's `CONNECTION_FAILED`
 * discipline (naming only what the adapter itself controls); the
 * previous shape embedded `err.message` verbatim, so whatever the
 * runtime's fetch put in its error — endpoint internals included —
 * became this adapter's message. Precedence is pinned: an HTTP
 * error status keeps its shape, and a timer-caused abort stays the
 * timeout. Exercised against stub fetches with a FAKE key; no
 * network, no real credentials.
 */

const MARKER = "SECRET-MARKER-transport-detail";
const FIXED = "LLM request failed before a complete response was received";
const CONFIG = { apiKey: "fake-key", baseUrl: "https://llm.example/v1", model: "fake-model" };

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function expectFixedFailure(err: unknown): void {
  expect(err).toBeInstanceOf(LlmExtractionError);
  const message = (err as Error).message;
  expect(message).toBe(FIXED);
  expect(message).not.toContain(MARKER);
  expect(message).not.toContain("fake-key");
  expect(message).not.toContain("fetch failed");
}

describe("LLM connection failure", () => {
  it("translates a refused fetch, carrying none of the transport text", async () => {
    const adapter = new OpenAiCompatibleLlmAdapter(CONFIG, {
      fetchFn: async () => {
        throw new TypeError(`fetch failed: ${MARKER}`);
      },
    });
    expectFixedFailure(await adapter.extract("x").catch((e: unknown) => e));
  });

  it("translates a non-Error transport rejection the same way (nothing stringified into the message)", async () => {
    const adapter = new OpenAiCompatibleLlmAdapter(CONFIG, {
      fetchFn: async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw `socket reset: ${MARKER}`;
      },
    });
    expectFixedFailure(await adapter.extract("x").catch((e: unknown) => e));
  });

  it("translates a mid-body reset (headers arrived, the body read rejects)", async () => {
    const adapter = new OpenAiCompatibleLlmAdapter(CONFIG, {
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("json() is not used by the LLM adapter");
        },
        text: async () => {
          throw new Error(`stream reset: ${MARKER}`);
        },
      }),
    });
    expectFixedFailure(await adapter.extract("x").catch((e: unknown) => e));
  });

  it("keeps an HTTP error status ahead of the translation", async () => {
    const adapter = new OpenAiCompatibleLlmAdapter(CONFIG, {
      fetchFn: async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => "internal error",
      }),
    });
    const err = await adapter.extract("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmExtractionError);
    expect((err as Error).message).toBe("LLM request returned HTTP 500");
  });

  it("keeps a timer-caused abort as the timeout, never the connection failure", async () => {
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
    expect((err as Error).message).not.toBe(FIXED);
  });

  it("keeps the fallback honesty: a connection failure surfaces the parser's original error", async () => {
    const adapter = new OpenAiCompatibleLlmAdapter(CONFIG, {
      fetchFn: async () => {
        throw new TypeError(`fetch failed: ${MARKER}`);
      },
    });
    const err = await parseBriefWithFallback("Blorp zibber flarn", { llm: adapter }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BriefParseError);
    expect(err).not.toBeInstanceOf(LlmExtractionError);
    expect((err as Error).message).not.toContain(MARKER);
  });

  it("is documented in the README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("before a complete response was received");
  });
});
