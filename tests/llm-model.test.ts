import { describe, expect, it, vi } from "vitest";
import {
  LLM_DEFAULT_MODEL,
  OpenAiCompatibleLlmAdapter,
  getLlmConfig,
  normalizeLlmModel,
} from "@/lib/agent";

/**
 * LLM model normalisation tests — the configured model name is
 * trimmed, and a value that is empty once trimmed falls back to
 * the default, in BOTH the env factory (`getLlmConfig`) and the
 * adapter constructor. Exercised against a stub fetch with a FAKE
 * key. No network, no real credentials. The stub captures the
 * exact request body, so a padded or blank model name (the
 * pre-normalisation failures) fails instead of silently passing.
 * Mirrors `tests/llm-base-url.test.ts` for the base URL.
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

function sentModel(fetchFn: ReturnType<typeof stubFetchReturning>): unknown {
  const [, init] = fetchFn.mock.calls[0]! as unknown as [
    string,
    { body: string },
  ];
  return (JSON.parse(init.body) as { model: unknown }).model;
}

describe("LLM model normalisation", () => {
  it("names the default model and uses it when none is configured", () => {
    expect(LLM_DEFAULT_MODEL).toBe("gpt-4o-mini");
    expect(getLlmConfig({ LLM_API_KEY: "fake-key" })?.model).toBe(
      LLM_DEFAULT_MODEL,
    );
    expect(normalizeLlmModel(undefined)).toBe(LLM_DEFAULT_MODEL);
    expect(normalizeLlmModel(null)).toBe(LLM_DEFAULT_MODEL);
  });

  it("trims surrounding whitespace from the env-configured model", () => {
    expect(
      getLlmConfig({ LLM_API_KEY: "fake-key", LLM_MODEL: "  local-model  " })
        ?.model,
    ).toBe("local-model");
  });

  it("falls back to the default for a blank or whitespace-only env value", () => {
    for (const model of ["", "   ", "\t \n"]) {
      expect(
        getLlmConfig({ LLM_API_KEY: "fake-key", LLM_MODEL: model })?.model,
      ).toBe(LLM_DEFAULT_MODEL);
      expect(normalizeLlmModel(model)).toBe(LLM_DEFAULT_MODEL);
    }
  });

  it("preserves an ordinary configured model exactly", () => {
    expect(
      getLlmConfig({ LLM_API_KEY: "fake-key", LLM_MODEL: "gpt-4o" })?.model,
    ).toBe("gpt-4o");
    expect(normalizeLlmModel("some-provider/model-v2")).toBe(
      "some-provider/model-v2",
    );
  });

  it("normalises a directly constructed adapter's model and sends the trimmed name", async () => {
    const fetchFn = stubFetchReturning(EXTRACTION);
    const adapter = new OpenAiCompatibleLlmAdapter(
      {
        apiKey: "fake-key",
        baseUrl: "https://llm.example/v1",
        model: "  local-model  ",
      },
      { fetchFn: fetchFn as never },
    );
    expect(adapter.model).toBe("local-model");
    const extraction = await adapter.extract("Remind Ana about her invoice");
    expect(extraction.steps).toHaveLength(1);
    expect(sentModel(fetchFn)).toBe("local-model");
  });

  it("falls back to the default in the adapter constructor for a blank model", async () => {
    const fetchFn = stubFetchReturning(EXTRACTION);
    const adapter = new OpenAiCompatibleLlmAdapter(
      { apiKey: "fake-key", baseUrl: "https://llm.example/v1", model: "   " },
      { fetchFn: fetchFn as never },
    );
    expect(adapter.model).toBe(LLM_DEFAULT_MODEL);
    await adapter.extract("Remind Ana about her invoice");
    expect(sentModel(fetchFn)).toBe(LLM_DEFAULT_MODEL);
  });

  it("preserves a directly constructed adapter's ordinary model exactly", async () => {
    const fetchFn = stubFetchReturning(EXTRACTION);
    const adapter = new OpenAiCompatibleLlmAdapter(
      { apiKey: "fake-key", baseUrl: "https://llm.example/v1", model: "gpt-4o" },
      { fetchFn: fetchFn as never },
    );
    expect(adapter.model).toBe("gpt-4o");
    await adapter.extract("Remind Ana about her invoice");
    expect(sentModel(fetchFn)).toBe("gpt-4o");
  });
});
