/**
 * Optional LLM adapter — the deterministic parser's fallback, never its
 * replacement (CONCEPT.md §3.1 / §3.6).
 *
 * Doctrine:
 *  - **Off by default.** With no `LLM_API_KEY` in the environment there is
 *    no adapter, no network call, and the app is fully functional —
 *    including Judge Mode.
 *  - **Deterministic-first.** `parseBriefWithFallback` always tries the
 *    deterministic parser first. The LLM is consulted only when the
 *    deterministic parser cannot find a money action in the brief.
 *  - **The LLM proposes, code disposes.** The model returns a small JSON
 *    extraction; every field is validated in code (step-type whitelist,
 *    currency whitelist, positive finite amounts under a hard cap, ISO
 *    due dates, required recipients/descriptions) before it is converted
 *    — by deterministic code, reusing the parser's contact book and the
 *    exact payload shapes the executor consumes — into a typed
 *    `ActionPlan`. An invalid, failed, or unreachable LLM response falls
 *    back to the deterministic parser's original error, never to a raw
 *    model error or a half-valid plan.
 *  - **Approval gate unchanged.** An LLM-sourced plan is an ordinary
 *    `pending_approval` plan (marked `source: "llm"` for the audit
 *    trail); nothing executes without the same explicit approval.
 *  - **Transport failures carry no transport text.** A call that gets
 *    no complete response (refused connection, DNS failure, reset
 *    mid-body) surfaces as a fixed `LlmExtractionError` message —
 *    never the raw fetch error's own text, mirroring the sandbox
 *    adapter's `CONNECTION_FAILED` discipline.
 *  - **Malformed success envelope.** A 200 response whose JSON body
 *    is an object but whose first choice entry is not an object
 *    (`choices: [null]`, from a proxy or a non-conforming
 *    OpenAI-compatible endpoint) is refused as an
 *    `LlmExtractionError` ("LLM choice must be an object"), like
 *    every other envelope malformation. Until this check existed,
 *    the choice entry was dereferenced directly, so that one shape
 *    escaped as a raw `TypeError` — breaking this adapter's
 *    one-error-shape contract for direct `extract()` callers
 *    (`parseBriefWithFallback` catches every failure either way, so
 *    its fallback honesty was never affected). The refusal message
 *    is a fixed string: no part of the response body is carried.
 *
 * The HTTP layer is injectable (fetch + config), so the adapter is fully
 * unit-tested offline against a stub with a fake key — no network, no
 * real credentials anywhere in the tests.
 */

import type { ActionPlan, ActionStep, ActionType, CurrencyCode } from "../types";
import { BriefParseError, parseBrief, resolveContact, type ParseOptions } from "./parser";

export class LlmExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmExtractionError";
  }
}

/** Maximum response body, in UTF-8 bytes, for an LLM call. */
export const LLM_MAX_RESPONSE_BYTES = 262_144;

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Per-request timeout in ms (default 10s; spans the response body as well as the wait for headers). */
  timeoutMs?: number;
  /** Maximum response body in bytes. Defaults to LLM_MAX_RESPONSE_BYTES; non-positive or non-finite values fall back to the default. */
  maxResponseBytes?: number;
}

type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface LlmAdapterOptions {
  fetchFn?: FetchLike;
  contacts?: ParseOptions["contacts"];
}

/** Build the LLM config from the environment; null when the adapter is off. */
export function getLlmConfig(env: Record<string, string | undefined>): LlmConfig | null {
  const apiKey = env.LLM_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, ""),
    model: env.LLM_MODEL?.trim() || "gpt-4o-mini",
  };
}

/* ------------------------------------------------------------------ */
/* Extraction schema + validation                                      */
/* ------------------------------------------------------------------ */

export interface LlmStepExtraction {
  type: ActionType;
  recipientName?: string;
  amount?: string;
  currency?: CurrencyCode;
  description?: string;
  dueDate?: string;
  gatedOnInvoicePaid?: boolean;
  invoiceRef?: string;
}

export interface LlmExtraction {
  steps: LlmStepExtraction[];
}

const STEP_TYPES: readonly ActionType[] = ["create_invoice", "create_order", "draft_payout", "send_reminder"];
const CURRENCIES: readonly CurrencyCode[] = ["USD", "EUR", "GBP"];
/** Hard cap on any single LLM-proposed amount — code-enforced, not prompt-enforced. */
export const MAX_LLM_AMOUNT = 100_000;

function fail(message: string): never {
  throw new LlmExtractionError(message);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function cleanName(value: unknown, what: string): string {
  if (typeof value !== "string") fail(`${what} must be a string`);
  const name = value.trim();
  if (!name || name.length > 80) fail(`${what} must be 1–80 characters`);
  return name;
}

function cleanAmount(value: unknown): string {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/,/g, "")) : NaN;
  if (!Number.isFinite(n) || n <= 0) fail("amount must be a positive number");
  if (n > MAX_LLM_AMOUNT) fail(`amount exceeds the ${MAX_LLM_AMOUNT} cap for LLM-proposed steps`);
  return n.toFixed(2);
}

function cleanCurrency(value: unknown): CurrencyCode {
  if (value === undefined || value === null || value === "") return "USD";
  if (typeof value === "string" && (CURRENCIES as readonly string[]).includes(value.toUpperCase())) {
    return value.toUpperCase() as CurrencyCode;
  }
  return fail(`currency must be one of ${CURRENCIES.join(", ")}`);
}

function cleanDueDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("dueDate must be an ISO date (yyyy-mm-dd)");
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) fail("dueDate is not a real calendar date");
  return value;
}

/**
 * Validate an untrusted value as an LLM extraction. Throws
 * `LlmExtractionError` on the first violation — there is no partial
 * acceptance: one bad step rejects the whole extraction.
 */
export function validateLlmExtraction(raw: unknown): LlmExtraction {
  const root = asRecord(raw, "extraction");
  if (!Array.isArray(root.steps) || root.steps.length === 0) fail("extraction.steps must be a non-empty array");
  if (root.steps.length > 4) fail("extraction has too many steps (max 4)");
  const steps: LlmStepExtraction[] = root.steps.map((rawStep, i) => {
    const s = asRecord(rawStep, `steps[${i}]`);
    if (typeof s.type !== "string" || !(STEP_TYPES as readonly string[]).includes(s.type)) {
      fail(`steps[${i}].type must be one of ${STEP_TYPES.join(", ")}`);
    }
    const type = s.type as ActionType;
    const step: LlmStepExtraction = { type };
    if (type === "create_invoice" || type === "draft_payout" || type === "send_reminder") {
      step.recipientName = cleanName(s.recipientName ?? s.recipient, `steps[${i}].recipientName`);
    }
    if (type === "create_invoice" || type === "draft_payout" || type === "create_order") {
      step.amount = cleanAmount(s.amount);
      step.currency = cleanCurrency(s.currency);
    }
    if (type === "create_invoice" || type === "create_order") {
      if (typeof s.description !== "string" || !s.description.trim()) fail(`steps[${i}].description is required`);
      step.description = s.description.trim().slice(0, 200);
    }
    if (type === "create_invoice") step.dueDate = cleanDueDate(s.dueDate);
    if (type === "draft_payout") {
      if (s.gatedOnInvoicePaid !== undefined && typeof s.gatedOnInvoicePaid !== "boolean") {
        fail(`steps[${i}].gatedOnInvoicePaid must be a boolean`);
      }
      step.gatedOnInvoicePaid = s.gatedOnInvoicePaid === true;
    }
    if (type === "send_reminder" && typeof s.invoiceRef === "string" && s.invoiceRef.trim()) {
      step.invoiceRef = s.invoiceRef.trim().slice(0, 64);
    }
    return step;
  });
  return { steps };
}

/* ------------------------------------------------------------------ */
/* Extraction → plan (deterministic conversion, parser payload shapes) */
/* ------------------------------------------------------------------ */

const PAYPAL_CALLS: Record<ActionType, { method: string; path: string }> = {
  create_invoice: { method: "POST", path: "/v2/invoicing/invoices (+ /send)" },
  create_order: { method: "POST", path: "/v2/checkout/orders" },
  draft_payout: { method: "POST", path: "/v1/payments/payouts" },
  send_reminder: { method: "POST", path: "/v2/invoicing/invoices/:id/remind" },
};

let llmPlanSeq = 0;

export function extractionToPlan(extraction: LlmExtraction, brief: string, options: ParseOptions = {}): ActionPlan {
  const now = options.now ?? new Date();
  const contacts = options.contacts;
  const steps: ActionStep[] = extraction.steps.map((s) => {
    const paypalCall = PAYPAL_CALLS[s.type];
    if (s.type === "create_invoice") {
      const recipient = resolveContact(s.recipientName!, contacts);
      const amt = { currency_code: s.currency!, value: s.amount! };
      return {
        type: s.type,
        description: `Invoice ${recipient.name} ${amt.currency_code} ${amt.value} for ${s.description}${s.dueDate ? `, due ${s.dueDate}` : ""} — create the draft and send it`,
        paypalCall,
        payload: { recipient, items: [{ name: s.description!, quantity: "1", unit_amount: amt }], dueDate: s.dueDate },
      };
    }
    if (s.type === "create_order") {
      const amt = { currency_code: s.currency!, value: s.amount! };
      return {
        type: s.type,
        description: `Create a checkout order: ${s.description} — ${amt.currency_code} ${amt.value}`,
        paypalCall,
        payload: { description: s.description!, amount: amt },
      };
    }
    if (s.type === "draft_payout") {
      const recipient = resolveContact(s.recipientName!, contacts);
      const amt = { currency_code: s.currency!, value: s.amount! };
      const step: ActionStep = {
        type: s.type,
        description: `Pay out ${amt.currency_code} ${amt.value} to ${recipient.name}${s.gatedOnInvoicePaid ? " — only after the invoice payment lands" : ""}`,
        paypalCall,
        payload: { recipient, amount: amt, note: `Payout to ${recipient.name} (LedgerPilot plan)` },
      };
      if (s.gatedOnInvoicePaid) step.trigger = { on: "INVOICING.INVOICE.PAID" };
      return step;
    }
    const recipient = resolveContact(s.recipientName!, contacts);
    return {
      type: s.type,
      description: `Send a payment reminder to ${recipient.name}${s.invoiceRef ? ` about invoice ${s.invoiceRef}` : " about their most-overdue open invoice"}`,
      paypalCall,
      payload: { recipient, invoiceRef: s.invoiceRef ?? null },
    };
  });
  llmPlanSeq += 1;
  return {
    id: options.planId ?? `plan-llm-${String(llmPlanSeq).padStart(4, "0")}`,
    brief: brief.trim(),
    steps,
    status: "pending_approval",
    createdAt: now.toISOString(),
    source: "llm",
  };
}

/* ------------------------------------------------------------------ */
/* OpenAI-compatible adapter                                           */
/* ------------------------------------------------------------------ */

export const LLM_SYSTEM_PROMPT = [
  "You extract money actions from a freelancer's plain-English brief for LedgerPilot.",
  "Reply with JSON only, no prose, in exactly this shape:",
  '{"steps":[{"type":"create_invoice|create_order|draft_payout|send_reminder",',
  '"recipientName":"person name (invoice/payout/reminder)","amount":123.45,',
  '"currency":"USD|EUR|GBP","description":"what the invoice or order is for",',
  '"dueDate":"yyyy-mm-dd (invoice only, omit if unstated)",',
  '"gatedOnInvoicePaid":true (payout only, when it must wait until an invoice is paid),',
  '"invoiceRef":"reference (reminder only, omit if unstated)"}]}',
  "Use only amounts, people, and dates stated in the brief. Never invent any of them.",
].join(" ");

export interface LlmBriefExtractor {
  extract(brief: string): Promise<LlmExtraction>;
}

export class OpenAiCompatibleLlmAdapter implements LlmBriefExtractor {
  private readonly fetchFn: FetchLike;

  constructor(
    private readonly config: LlmConfig,
    options: LlmAdapterOptions = {},
  ) {
    this.fetchFn = options.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  }

  async extract(brief: string): Promise<LlmExtraction> {
    const controller = new AbortController();
    const timeoutMs = this.config.timeoutMs ?? 10_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Awaited<ReturnType<FetchLike>>;
    let rawText: string;
    try {
      res = await this.fetchFn(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          messages: [
            { role: "system", content: LLM_SYSTEM_PROMPT },
            { role: "user", content: brief },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new LlmExtractionError(`LLM request returned HTTP ${res.status}`);
      // The per-request timeout spans the response body, not just
      // the wait for the headers: the timer stays armed while the
      // body is read, so an endpoint that answers promptly and then
      // drips — or never finishes — its body is aborted by the same
      // bound instead of hanging the caller with the headers in hand.
      rawText = await res.text();
    } catch (err) {
      if (err instanceof LlmExtractionError) throw err;
      if (controller.signal.aborted) {
        throw new LlmExtractionError(`LLM request timed out after ${timeoutMs} ms`);
      }
      // A transport failure — a refused connection, a DNS failure,
      // a reset before or during the body — is translated into a
      // fixed message, never the transport error's own text: that
      // text is the runtime's, not this adapter's contract, and can
      // carry endpoint internals. The sandbox adapter translates the
      // same failure class the same way (`CONNECTION_FAILED`, naming
      // method + path only); here the honest shape is a plain
      // failure with no detail, and `parseBriefWithFallback` still
      // rethrows the deterministic parser's original error either
      // way.
      throw new LlmExtractionError("LLM request failed before a complete response was received");
    } finally {
      clearTimeout(timer);
    }
    // The response body is measured before it is parsed: the timeout
    // bounds how long the call may take, this bound limits how much
    // it may return, so an endpoint answering with an arbitrarily
    // large body is refused for its size (naming the limit only,
    // never any of the body) instead of being buffered and parsed.
    const maxResponseBytes =
      this.config.maxResponseBytes !== undefined &&
      Number.isFinite(this.config.maxResponseBytes) &&
      this.config.maxResponseBytes > 0
        ? this.config.maxResponseBytes
        : LLM_MAX_RESPONSE_BYTES;
    if (new TextEncoder().encode(rawText).byteLength > maxResponseBytes) {
      throw new LlmExtractionError(`LLM response exceeded the ${maxResponseBytes}-byte limit`);
    }
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawText);
    } catch {
      throw new LlmExtractionError("LLM response is not valid JSON");
    }
    const body = asRecord(parsedBody, "LLM response");
    const choices = body.choices;
    if (!Array.isArray(choices) || choices.length === 0) fail("LLM response has no choices");
    // The choice entry itself is validated before it is dereferenced:
    // a null (or otherwise non-object) entry must surface as an
    // LlmExtractionError, never a raw TypeError — see the header's
    // malformed-success-envelope note.
    const choice = asRecord(choices[0], "LLM choice");
    const message = asRecord(choice.message, "LLM choice message");
    if (typeof message.content !== "string") fail("LLM choice has no text content");
    const jsonText = message.content.replace(/```(?:json)?/g, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      fail("LLM response is not valid JSON");
    }
    return validateLlmExtraction(parsed);
  }
}

/** The adapter for this process, or null when the LLM is off (the default). */
export function getDefaultLlmAdapter(env: Record<string, string | undefined> = process.env): LlmBriefExtractor | null {
  const config = getLlmConfig(env);
  return config ? new OpenAiCompatibleLlmAdapter(config) : null;
}

/* ------------------------------------------------------------------ */
/* Deterministic-first entry point                                     */
/* ------------------------------------------------------------------ */

export interface SmartParseOptions extends ParseOptions {
  /** When null/omitted, behavior is exactly the deterministic parser's. */
  llm?: LlmBriefExtractor | null;
}

/**
 * Parse a brief into a plan: deterministic parser first; only when it
 * finds no money action *and* an LLM adapter is configured, the LLM
 * extraction path runs (validated, then converted deterministically).
 * Any LLM failure rethrows the deterministic parser's original
 * `BriefParseError`, so callers see one honest error shape.
 */
export async function parseBriefWithFallback(brief: string, options: SmartParseOptions = {}): Promise<ActionPlan> {
  try {
    return parseBrief(brief, options);
  } catch (err) {
    if (!(err instanceof BriefParseError) || !options.llm) throw err;
    try {
      const extraction = await options.llm.extract(brief);
      return extractionToPlan(extraction, brief, options);
    } catch {
      throw err;
    }
  }
}
