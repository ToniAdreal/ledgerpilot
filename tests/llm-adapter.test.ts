/**
 * Optional LLM adapter — deterministic-first doctrine, pinned:
 *  - off by default (no LLM_API_KEY → no adapter, no calls);
 *  - when the deterministic parser succeeds, the LLM is never consulted;
 *  - when it fails, a *validated* LLM extraction becomes an ordinary
 *    pending_approval plan (source: "llm") with parser-identical payload
 *    shapes, and the full approval-gated loop executes it end-to-end;
 *  - invalid / failed / unreachable LLM output falls back to the
 *    deterministic parser's original BriefParseError — never a raw model
 *    error, never a half-valid plan.
 * All HTTP is stubbed with a fake key; no network, no real credentials.
 */

import { describe, expect, it, vi } from "vitest";
import {
  BriefParseError,
  LlmExtractionError,
  OpenAiCompatibleLlmAdapter,
  executePlan,
  extractionToPlan,
  getDefaultLlmAdapter,
  getLlmConfig,
  parseBriefWithFallback,
  validateLlmExtraction,
  type LlmBriefExtractor,
} from "@/lib/agent";
import { LedgerStore } from "@/lib/agent/store";
import { MockPayPalClient } from "@/lib/paypal/mock";

const NOW = new Date("2026-10-10T00:00:00Z"); // Saturday, per judge-mode reference date

function stubFetchReturning(content: string, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => content,
  }));
}

const GOOD_EXTRACTION = JSON.stringify({
  steps: [
    {
      type: "create_invoice",
      recipientName: "Ana",
      amount: 450,
      currency: "USD",
      description: "brand work",
      dueDate: "2026-10-16",
    },
    { type: "draft_payout", recipientName: "Marco", amount: 200, currency: "USD", gatedOnInvoicePaid: true },
  ],
});

describe("LLM config (off by default)", () => {
  it("returns null without an API key and applies defaults with one", () => {
    expect(getLlmConfig({})).toBeNull();
    expect(getLlmConfig({ LLM_API_KEY: "  " })).toBeNull();
    expect(getDefaultLlmAdapter({})).toBeNull();
    const cfg = getLlmConfig({ LLM_API_KEY: "fake-key" });
    expect(cfg).toMatchObject({ apiKey: "fake-key", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" });
    const custom = getLlmConfig({ LLM_API_KEY: "k", LLM_BASE_URL: "http://localhost:9999/v1/", LLM_MODEL: "local-model" });
    expect(custom).toMatchObject({ baseUrl: "http://localhost:9999/v1", model: "local-model" });
  });
});

describe("extraction validation", () => {
  it("accepts a well-formed extraction and normalises amounts/currency", () => {
    const out = validateLlmExtraction({
      steps: [{ type: "draft_payout", recipientName: "Marco", amount: "200", currency: "eur" }],
    });
    expect(out.steps[0]).toMatchObject({ amount: "200.00", currency: "EUR", gatedOnInvoicePaid: false });
  });

  it.each([
    ["unknown step type", { steps: [{ type: "wire_money", recipientName: "Ana", amount: 10 }] }],
    ["negative amount", { steps: [{ type: "draft_payout", recipientName: "Marco", amount: -5 }] }],
    ["amount over the hard cap", { steps: [{ type: "draft_payout", recipientName: "Marco", amount: 100_001 }] }],
    ["non-whitelisted currency", { steps: [{ type: "draft_payout", recipientName: "Marco", amount: 5, currency: "JPY" }] }],
    ["missing recipient", { steps: [{ type: "create_invoice", amount: 5, description: "x" }] }],
    ["missing order description", { steps: [{ type: "create_order", amount: 5 }] }],
    ["impossible due date", { steps: [{ type: "create_invoice", recipientName: "Ana", amount: 5, description: "x", dueDate: "2026-02-30" }] }],
    ["empty steps", { steps: [] }],
    ["too many steps", { steps: Array.from({ length: 5 }, () => ({ type: "send_reminder", recipientName: "Ana" })) }],
  ])("rejects %s", (_label, raw) => {
    expect(() => validateLlmExtraction(raw)).toThrow(LlmExtractionError);
  });

  it("one bad step rejects the whole extraction (no partial acceptance)", () => {
    expect(() =>
      validateLlmExtraction({
        steps: [
          { type: "create_invoice", recipientName: "Ana", amount: 450, description: "brand work" },
          { type: "draft_payout", recipientName: "Marco", amount: -1 },
        ],
      }),
    ).toThrow(LlmExtractionError);
  });
});

describe("OpenAiCompatibleLlmAdapter (stub fetch, fake key)", () => {
  it("posts the chat-completions shape and parses a fenced JSON reply", async () => {
    const fetchFn = stubFetchReturning("```json\n" + GOOD_EXTRACTION + "\n```");
    const adapter = new OpenAiCompatibleLlmAdapter(
      { apiKey: "fake-key", baseUrl: "https://llm.example/v1", model: "m1" },
      { fetchFn: fetchFn as never },
    );
    const extraction = await adapter.extract("Bill Ana for the brand work");
    expect(extraction.steps).toHaveLength(2);
    const [url, init] = fetchFn.mock.calls[0]! as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://llm.example/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer fake-key");
    expect(JSON.parse(init.body)).toMatchObject({ model: "m1", temperature: 0 });
  });

  it("throws LlmExtractionError on HTTP failure and on non-JSON content", async () => {
    const failing = new OpenAiCompatibleLlmAdapter(
      { apiKey: "fake-key", baseUrl: "https://llm.example/v1", model: "m1" },
      { fetchFn: stubFetchReturning("nope", 500) as never },
    );
    await expect(failing.extract("x")).rejects.toThrow(LlmExtractionError);
    const gibberish = new OpenAiCompatibleLlmAdapter(
      { apiKey: "fake-key", baseUrl: "https://llm.example/v1", model: "m1" },
      { fetchFn: stubFetchReturning("I cannot do that") as never },
    );
    await expect(gibberish.extract("x")).rejects.toThrow(LlmExtractionError);
  });
});

describe("parseBriefWithFallback — deterministic-first", () => {
  const BRIEF_OK = "Invoice Ana $450 for brand work, due Friday. When it lands, pay $200 to my contractor Marco.";
  const BRIEF_DET_MISS = "Could you sort out the brand work billing for Ana and send Marco his cut once we're paid?";

  it("never consults the LLM when the deterministic parser succeeds", async () => {
    const extract = vi.fn(async () => validateLlmExtraction(JSON.parse(GOOD_EXTRACTION)));
    const llm: LlmBriefExtractor = { extract };
    const plan = await parseBriefWithFallback(BRIEF_OK, { llm, now: NOW });
    expect(plan.source).toBe("deterministic");
    expect(plan.status).toBe("pending_approval");
    expect(extract).not.toHaveBeenCalled();
  });

  it("with no LLM configured, a deterministic miss is the plain BriefParseError", async () => {
    await expect(parseBriefWithFallback(BRIEF_DET_MISS, { llm: null, now: NOW })).rejects.toThrow(BriefParseError);
  });

  it("falls back to a validated LLM plan on a deterministic miss", async () => {
    const llm: LlmBriefExtractor = { extract: async () => validateLlmExtraction(JSON.parse(GOOD_EXTRACTION)) };
    const plan = await parseBriefWithFallback(BRIEF_DET_MISS, { llm, now: NOW });
    expect(plan.source).toBe("llm");
    expect(plan.status).toBe("pending_approval");
    expect(plan.steps.map((s) => s.type)).toEqual(["create_invoice", "draft_payout"]);
    expect(plan.steps[1]!.trigger?.on).toBe("INVOICING.INVOICE.PAID");
    // Payload shapes are the executor's shapes, identical to the deterministic parser's.
    expect(plan.steps[0]!.payload).toMatchObject({
      recipient: { name: "Ana", email_address: "ana@example.com" },
      dueDate: "2026-10-16",
    });
  });

  it("an LLM failure or invalid extraction rethrows the original BriefParseError", async () => {
    const down: LlmBriefExtractor = {
      extract: async () => {
        throw new LlmExtractionError("LLM request returned HTTP 500");
      },
    };
    await expect(parseBriefWithFallback(BRIEF_DET_MISS, { llm: down, now: NOW })).rejects.toThrow(BriefParseError);
    const invalid: LlmBriefExtractor = {
      extract: async () => validateLlmExtraction({ steps: [{ type: "wire_money", amount: 1 }] }),
    };
    await expect(parseBriefWithFallback(BRIEF_DET_MISS, { llm: invalid, now: NOW })).rejects.toThrow(BriefParseError);
  });

  it("an LLM-sourced plan runs the full approval-gated loop end-to-end", async () => {
    const store = new LedgerStore();
    const client = new MockPayPalClient();
    const plan = store.addPlan(extractionToPlan(validateLlmExtraction(JSON.parse(GOOD_EXTRACTION)), BRIEF_DET_MISS, { now: NOW }));
    // The gate is unchanged for LLM plans: unapproved execution is refused.
    await expect(executePlan(store, client, plan.id)).rejects.toThrow(/requires approval/);
    store.approvePlan(plan.id);
    const first = await executePlan(store, client, plan.id);
    expect(first.plan.status).toBe("awaiting_trigger");
    const invoiceId = first.outcomes.find((o) => o.step.type === "create_invoice")!.resultId!;
    await client.recordInvoicePayment(invoiceId, { value: "450.00", currency_code: "USD" });
    const { resumeTriggeredSteps } = await import("@/lib/agent");
    const resumed = await resumeTriggeredSteps(store, client, "INVOICING.INVOICE.PAID", invoiceId);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.plan.status).toBe("completed");
    const txns = await client.listTransactions();
    expect(txns.map((t) => t.transaction_amount.value)).toEqual(expect.arrayContaining(["450.00", "-200.00"]));
  });
});
