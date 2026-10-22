import { describe, expect, it, vi } from "vitest";
import {
  LLM_DEFAULT_BASE_URL,
  OpenAiCompatibleLlmAdapter,
  getLlmConfig,
  normalizeLlmBaseUrl,
} from "@/lib/agent";

/**
 * LLM base-URL normalisation tests — the configured base URL is
 * trimmed and stripped of ALL trailing slashes, and a value that is
 * empty once normalised falls back to the default, in BOTH the
 * env factory (`getLlmConfig`) and the adapter constructor.
 * Exercised against a stub fetch with a FAKE key. No network, no
 * real credentials. The stub captures the exact request URL, so a
 * double-slash or relative URL (the pre-normalisation failures)
 * fails instead of silently passing. Mirrors
 * `tests/sandbox-base-url.test.ts` for the sandbox adapter.
 */

const EXTRACTION = JSON.stringify({
  steps: [{ type: "send_reminder", recipientName: "Ana" }],
});

function stubFetchReturning(content: string) {
  const envelope = { choices: [{ message: { content } }] };
  const fetchFn = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => envelope,
    text: async () => JSON.stringify(envelope),
  }));
  return fetchFn;
}

describe("LLM base URL normalisation", () => {
  it("names the default base URL and uses it when none is configured", () => {
    expect(LLM_DEFAULT_BASE_URL).toBe("https://api.openai.com/v1");
    expect(getLlmConfig({ LLM_API_KEY: "fake-key" })?.baseUrl).toBe(LLM_DEFAULT_BASE_URL);
    expect(normalizeLlmBaseUrl(undefined)).toBe(LLM_DEFAULT_BASE_URL);
    expect(normalizeLlmBaseUrl(null)).toBe(LLM_DEFAULT_BASE_URL);
  });

  it("strips a single trailing slash (the pre-existing env behaviour)", () => {
    expect(
      getLlmConfig({ LLM_API_KEY: "fake-key", LLM_BASE_URL: "https://llm.example/v1/" })?.baseUrl,
    ).toBe("https://llm.example/v1");
  });

  it("strips ALL trailing slashes, not just one", () => {
    expect(
      getLlmConfig({ LLM_API_KEY: "fake-key", LLM_BASE_URL: "https://llm.example/v1///" })?.baseUrl,
    ).toBe("https://llm.example/v1");
  });

  it("trims surrounding whitespace before stripping slashes", () => {
    expect(
      getLlmConfig({ LLM_API_KEY: "fake-key", LLM_BASE_URL: "  https://llm.example/v1//  " })?.baseUrl,
    ).toBe("https://llm.example/v1");
  });

  it("falls back to the default for a blank or slashes-only env value", () => {
    for (const baseUrl of ["", "   ", "///", "  ///  "]) {
      expect(getLlmConfig({ LLM_API_KEY: "fake-key", LLM_BASE_URL: baseUrl })?.baseUrl).toBe(
        LLM_DEFAULT_BASE_URL,
      );
      expect(normalizeLlmBaseUrl(baseUrl)).toBe(LLM_DEFAULT_BASE_URL);
    }
  });

  it("preserves an ordinary configured base URL exactly, path suffix included", () => {
    expect(
      getLlmConfig({ LLM_API_KEY: "fake-key", LLM_BASE_URL: "https://llm.example/openai/v1" })?.baseUrl,
    ).toBe("https://llm.example/openai/v1");
  });

  it("normalises a directly constructed adapter's base URL and builds the request URL with exactly one slash", async () => {
    const fetchFn = stubFetchReturning(EXTRACTION);
    const adapter = new OpenAiCompatibleLlmAdapter(
      { apiKey: "fake-key", baseUrl: "  https://llm.example/v1///  ", model: "m1" },
      { fetchFn: fetchFn as never },
    );
    expect(adapter.baseUrl).toBe("https://llm.example/v1");
    const extraction = await adapter.extract("Remind Ana about her invoice");
    expect(extraction.steps).toHaveLength(1);
    const [url] = fetchFn.mock.calls[0]! as unknown as [string];
    expect(url).toBe("https://llm.example/v1/chat/completions");
  });

  it("falls back to the default in the adapter constructor for a slashes-only base URL", async () => {
    const fetchFn = stubFetchReturning(EXTRACTION);
    const adapter = new OpenAiCompatibleLlmAdapter(
      { apiKey: "fake-key", baseUrl: "///", model: "m1" },
      { fetchFn: fetchFn as never },
    );
    expect(adapter.baseUrl).toBe(LLM_DEFAULT_BASE_URL);
    await adapter.extract("Remind Ana about her invoice");
    const [url] = fetchFn.mock.calls[0]! as unknown as [string];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
  });
});
