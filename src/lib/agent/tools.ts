/**
 * Agent tool definitions — the tool-call-shaped action layer CONCEPT.md
 * §1 names as the stretch goal: "Optionally the PayPal MCP server /
 * Agent Toolkit tool definitions as the agent's action layer (same
 * operations, tool-call shaped) — a stretch goal, REST first." REST
 * shipped first, as the concept requires; this module is the tool-call
 * shape of the same four operations, for MCP-style / Agent
 * Toolkit-style clients that speak `{ name, arguments }` instead of
 * prose briefs or resource-shaped REST bodies.
 *
 * Doctrine (the same one every other plan source follows):
 *  - **Tools propose, code disposes.** A tool definition is a name, a
 *    description, and a JSON Schema for its arguments — nothing here
 *    executes. A tool *call* is validated in code and converted into a
 *    typed `ActionPlan` step; the plan is an ordinary
 *    `pending_approval` plan (marked `source: "tool"` for the audit
 *    trail) and PayPal is called only by the ordinary
 *    approve → execute flow. The approval gate has no tool-call back
 *    door either.
 *  - **One validation, not three.** Conversion delegates field
 *    validation to the resource drafts (`./drafts.ts`) — the same code
 *    the `POST /api/paypal/*` wrappers use — so a tool step is
 *    payload-identical to the equivalent draft step (test-pinned), and
 *    the amount cap, currency whitelist, and real-calendar due-date
 *    rule can never drift between surfaces. This module adds only the
 *    envelope rules a schema cannot enforce through the drafts:
 *    unknown tool names, non-object arguments, and argument keys the
 *    tool's schema does not declare are rejected, never ignored.
 *  - **Gating, two honest forms.** A payout call may carry
 *    `payWhenInvoicePaid: "<invoiceId>"` (pre-bound to that invoice, the
 *    drafts form) or `gatedOnInvoicePaid: true` (an unbound
 *    `INVOICING.INVOICE.PAID` trigger, the parser/LLM form — the
 *    executor binds it at execution time to the invoice its own plan
 *    created, which is what makes a one-plan invoice + payout tool
 *    sequence work). Carrying both is ambiguous and rejected.
 */

import type { ActionPlan, ActionStep, ActionType } from "../types";
import {
  DraftValidationError,
  draftInvoicePlan,
  draftOrderPlan,
  draftPayoutPlan,
  draftReminderPlan,
  type DraftOptions,
} from "./drafts";

export class ToolCallError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ToolCallError";
  }
}

/** The JSON Schema subset these definitions use (plain JSON, MCP `inputSchema` shape). */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  anyOf?: Array<Record<string, unknown>>;
  additionalProperties: false;
}

export interface AgentToolDefinition {
  /** Tool name — exactly the typed action it drafts. */
  name: ActionType;
  description: string;
  inputSchema: ToolInputSchema;
}

/** One tool call, MCP / Agent Toolkit shaped: a name plus its arguments object. */
export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

const AMOUNT_SCHEMA: Record<string, unknown> = {
  type: "number",
  exclusiveMinimum: 0,
  maximum: 100_000,
  description: "Amount in the given currency; must be greater than zero and at most 100000.",
};

const CURRENCY_SCHEMA: Record<string, unknown> = {
  type: "string",
  enum: ["USD", "EUR", "GBP"],
  default: "USD",
  description: "Currency code; USD when omitted.",
};

const GATE_NOTE =
  "Drafts a pending-approval plan step only — nothing is sent to PayPal until the plan is approved and executed.";

export const AGENT_TOOLS: readonly AgentToolDefinition[] = [
  {
    name: "create_invoice",
    description:
      `Create and send a PayPal Invoicing v2 invoice (POST /v2/invoicing/invoices + /send). ${GATE_NOTE}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["recipientName", "amount", "description"],
      properties: {
        recipientName: { type: "string", description: "Who the invoice bills (demo contact book / slug fallback resolves the email)." },
        recipientEmail: { type: "string", description: "Explicit recipient email; overrides the contact-book resolution." },
        amount: AMOUNT_SCHEMA,
        currency: CURRENCY_SCHEMA,
        description: { type: "string", description: "What the invoice is for (the single line item)." },
        dueDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Optional due date, ISO yyyy-mm-dd, must be a real calendar date." },
        note: { type: "string", description: "Optional note carried on the invoice." },
        reference: { type: "string", description: "Optional seller reference carried on the invoice." },
      },
    },
  },
  {
    name: "create_order",
    description:
      `Create a PayPal Orders v2 checkout order (POST /v2/checkout/orders) for a one-off sale. ${GATE_NOTE}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["description", "amount"],
      properties: {
        description: { type: "string", description: "What is being sold." },
        amount: AMOUNT_SCHEMA,
        currency: CURRENCY_SCHEMA,
        reference: { type: "string", description: "Optional seller reference id for the order." },
      },
    },
  },
  {
    name: "draft_payout",
    description:
      `Draft a PayPal Payouts batch (POST /v1/payments/payouts) — one recipient, or a batch via items. ` +
      `Gate it on an invoice payment with payWhenInvoicePaid (a specific invoice id) or gatedOnInvoicePaid ` +
      `(true = wait for this plan's own invoice payment); never both. ${GATE_NOTE}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      anyOf: [{ required: ["recipientName", "amount"] }, { required: ["items"] }],
      properties: {
        recipientName: { type: "string", description: "Single-recipient form: who gets paid." },
        recipientEmail: { type: "string", description: "Single-recipient form: explicit recipient email." },
        amount: AMOUNT_SCHEMA,
        currency: CURRENCY_SCHEMA,
        note: { type: "string", description: "Payout note (batch form: the fallback note for lines without one)." },
        payWhenInvoicePaid: { type: "string", description: "Invoice id this payout waits for (pre-bound trigger)." },
        gatedOnInvoicePaid: { type: "boolean", description: "True = defer until an INVOICING.INVOICE.PAID event resumes the plan (bound at execution to the plan's own invoice)." },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 25,
          description: "Batch form: payout lines; mutually exclusive with the single-recipient fields.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["recipientName", "amount"],
            properties: {
              recipientName: { type: "string" },
              recipientEmail: { type: "string" },
              amount: AMOUNT_SCHEMA,
              currency: CURRENCY_SCHEMA,
              note: { type: "string" },
            },
          },
        },
      },
    },
  },
  {
    name: "send_reminder",
    description:
      `Send a payment reminder for an open invoice (POST /v2/invoicing/invoices/:id/remind). With no ` +
      `invoiceRef, the recipient's most-overdue open invoice is targeted at execution. ${GATE_NOTE}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["recipientName"],
      properties: {
        recipientName: { type: "string", description: "Who to remind." },
        recipientEmail: { type: "string", description: "Explicit recipient email; overrides the contact-book resolution." },
        invoiceRef: { type: "string", description: "Optional invoice id, invoice number, or reference; an unmatched reference fails the step at execution." },
      },
    },
  },
];

/** Deep copy of the canonical definitions — callers can never mutate the originals. */
export function listAgentTools(): AgentToolDefinition[] {
  return JSON.parse(JSON.stringify(AGENT_TOOLS)) as AgentToolDefinition[];
}

/** The definition for a tool name, or undefined when the name is not a LedgerPilot tool. */
export function getAgentTool(name: string): AgentToolDefinition | undefined {
  return AGENT_TOOLS.find((t) => t.name === name);
}

/* ------------------------------------------------------------------ */
/* Call validation + conversion (delegates field rules to the drafts)  */
/* ------------------------------------------------------------------ */

/**
 * Validate a raw value as one tool call: a known tool name and a plain
 * arguments object whose keys are all declared by the tool's schema.
 * Field-level rules (amounts, currencies, dates, emails) are enforced
 * at conversion time by the drafts, not duplicated here.
 */
export function parseToolCall(raw: unknown): ToolCall {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ToolCallError("A tool call must be an object shaped { name, arguments }");
  }
  const call = raw as Record<string, unknown>;
  if (typeof call.name !== "string" || !call.name.trim()) {
    throw new ToolCallError("A tool call requires a 'name' string");
  }
  const tool = getAgentTool(call.name);
  if (!tool) {
    throw new ToolCallError(
      `'${call.name}' is not a LedgerPilot tool — available tools: ${AGENT_TOOLS.map((t) => t.name).join(", ")}`,
    );
  }
  const args = call.arguments ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new ToolCallError(`Tool '${tool.name}': 'arguments' must be an object`);
  }
  const allowed = new Set(Object.keys(tool.inputSchema.properties));
  for (const key of Object.keys(args as Record<string, unknown>)) {
    if (!allowed.has(key)) {
      throw new ToolCallError(`Tool '${tool.name}': unknown argument '${key}' (not declared in its input schema)`);
    }
  }
  return { name: tool.name, arguments: args as Record<string, unknown> };
}

function draftStepFor(call: ToolCall, options: DraftOptions): ActionStep {
  const args = call.arguments;
  try {
    switch (call.name as ActionType) {
      case "create_invoice":
        return draftInvoicePlan(args, options).steps[0]!;
      case "create_order":
        return draftOrderPlan(args, options).steps[0]!;
      case "send_reminder":
        return draftReminderPlan(args, options).steps[0]!;
      case "draft_payout": {
        const gated = args.gatedOnInvoicePaid;
        if (gated !== undefined && typeof gated !== "boolean") {
          throw new ToolCallError("Tool 'draft_payout': 'gatedOnInvoicePaid' must be a boolean");
        }
        if (gated === true && args.payWhenInvoicePaid !== undefined && args.payWhenInvoicePaid !== null && args.payWhenInvoicePaid !== "") {
          throw new ToolCallError(
            "Tool 'draft_payout': 'gatedOnInvoicePaid' and 'payWhenInvoicePaid' are two different gates — pass one, not both",
          );
        }
        const draftArgs: Record<string, unknown> = { ...args };
        delete draftArgs.gatedOnInvoicePaid;
        const step = draftPayoutPlan(draftArgs, options).steps[0]!;
        if (gated === true) {
          step.trigger = { on: "INVOICING.INVOICE.PAID" };
          step.description += " — only after the invoice payment lands";
        }
        return step;
      }
    }
  } catch (err) {
    if (err instanceof DraftValidationError) throw new ToolCallError(err.message);
    throw err;
  }
  throw new ToolCallError(`'${call.name}' is not a LedgerPilot tool`);
}

export interface ToolPlanOptions extends DraftOptions {
  /** Plan brief override; defaults to a summary naming the calls. */
  brief?: string;
}

let toolPlanSeq = 0;

/** Most tool calls one plan may carry (the LLM extraction cap, applied to every multi-step source). */
export const MAX_TOOL_CALLS_PER_PLAN = 4;

/**
 * Convert one or more raw tool calls into a single typed
 * `pending_approval` plan (`source: "tool"`). Nothing executes — the
 * plan joins the ordinary approval queue like any other.
 */
export function toolCallsToPlan(rawCalls: unknown, options: ToolPlanOptions = {}): ActionPlan {
  if (!Array.isArray(rawCalls) || rawCalls.length === 0) {
    throw new ToolCallError("At least one tool call is required to draft a plan");
  }
  if (rawCalls.length > MAX_TOOL_CALLS_PER_PLAN) {
    throw new ToolCallError(`A plan carries at most ${MAX_TOOL_CALLS_PER_PLAN} tool calls (got ${rawCalls.length})`);
  }
  const calls = rawCalls.map(parseToolCall);
  const steps = calls.map((call) => draftStepFor(call, options));
  toolPlanSeq += 1;
  return {
    id: options.planId ?? `plan-tool-${String(toolPlanSeq).padStart(4, "0")}`,
    brief: options.brief ?? `Tool calls: ${calls.map((c) => c.name).join(" + ")}`,
    steps,
    status: "pending_approval",
    createdAt: (options.now ?? new Date()).toISOString(),
    source: "tool",
  };
}

/** Convert a single raw tool call into a one-step plan. */
export function toolCallToPlan(rawCall: unknown, options: ToolPlanOptions = {}): ActionPlan {
  return toolCallsToPlan([rawCall], options);
}
