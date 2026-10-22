import { describe, expect, it, vi } from "vitest";
import {
  LlmExtractionError,
  OpenAiCompatibleLlmAdapter,
  getLlmConfig,
  normalizeLlmApiKey,
} from "@/lib/agent";

/**
 * LLM API-key normalisation tests — the configured key is trimmed,
 * and a value that is empty once trimmed counts as not configured,
 * in BOTH the env factory (`getLlmConfig`, which returns null) and
 * the adapter constructor (which refuses a blank key instead of
 * sending it verbatim in the Bearer header). Exercised against a
 * stub fetch with a FAKE key. No network, no real credentials. The
 * stub captures the exact Authorization header, so a padded or
 * blank key (the pre-normalisation failures) fails instead of
 * silently passing. Mirrors `tests/llm-model.test.ts` and the
 * sandbox credential normalisation in
 * `tests/sandbox-credentials.test.ts`.
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

function sentAuthorization(
  fetchFn: ReturnType<typeof stubFetchReturning>,
): unknown {
  const [, init] = fetchFn.mock.calls[0]! as unknown as [
    string,
    { headers: Record<string, string> },
  ];
  return init.headers.authorization;
}

describe("LLM API-key normalisation", () => {
  it("trims surrounding whitespace from the env-configured key", () => {
    expect(
      getLlmConfig({ LLM_API_KEY: "  fake-key  " })?.apiKey,
    ).toBe("fake-key");
    expect(normalizeLlmApiKey("  fake-key  ")).toBe("fake-key");
  });

  it("treats a missing, blank, or whitespace-only env key as not configured", () => {
    expect(getLlmConfig({})).toBeNull();
    for (const key of ["", "   ", "\t \n"]) {
      expect(getLlmConfig({ LLM_API_KEY: key })).toBeNull();
      expect(normalizeLlmApiKey(key)).toBe("");
    }
    expect(normalizeLlmApiKey(undefined)).toBe("");
    expect(normalizeLlmApiKey(null)).toBe("");
  });

  it("preserves an ordinary configured key exactly", () => {
    expect(getLlmConfig({ LLM_API_KEY: "sk-fake-123" })?.apiKey).toBe(
      "sk-fake-123",
    );
    expect(normalizeLlmApiKey("sk-fake-123")).toBe("sk-fake-123");
  });

  it("normalises a directly constructed adapter's key and sends the trimmed value", async () => {
    const fetchFn = stubFetchReturning(EXTRACTION);
    const adapter = new OpenAiCompatibleLlmAdapter(
      {
        apiKey: "  fake-key  ",
        baseUrl: "https://llm.example/v1",
        model: "m1",
      },
      { fetchFn: fetchFn as never },
    );
    expect(adapter.apiKey).toBe("fake-key");
    const extraction = await adapter.extract("Remind Ana about her invoice");
    expect(extraction.steps).toHaveLength(1);
    expect(sentAuthorization(fetchFn)).toBe("Bearer fake-key");
  });

  it("refuses a directly constructed adapter with a blank key, naming no credential value", () => {
    for (const key of ["", "   ", "\t \n"]) {
      expect(
        () =>
          new OpenAiCompatibleLlmAdapter(
            { apiKey: key, baseUrl: "https://llm.example/v1", model: "m1" },
            { fetchFn: stubFetchReturning(EXTRACTION) as never },
          ),
      ).toThrow(LlmExtractionError);
    }
  });

  it("preserves a directly constructed adapter's ordinary key exactly", async () => {
    const fetchFn = stubFetchReturning(EXTRACTION);
    const adapter = new OpenAiCompatibleLlmAdapter(
      { apiKey: "sk-fake-123", baseUrl: "https://llm.example/v1", model: "m1" },
      { fetchFn: fetchFn as never },
    );
    expect(adapter.apiKey).toBe("sk-fake-123");
    await adapter.extract("Remind Ana about her invoice");
    expect(sentAuthorization(fetchFn)).toBe("Bearer sk-fake-123");
  });
});
