/**
 * Agent tool definitions — CONCEPT.md §1's stretch goal: the agent's
 * action layer in tool-call shape (MCP / Agent Toolkit style).
 *
 * Pinned here:
 *  - the four definitions (names = the typed action types, JSON
 *    Schemas with the required fields, currency enum, amount bounds,
 *    and additionalProperties: false), listed as defensive copies;
 *  - conversion delegating to the resource drafts — a tool step is
 *    identical (description, PayPal call, payload) to the equivalent
 *    draft step, for every action incl. batch and gated payouts;
 *  - the envelope rules: unknown tools, non-object arguments, and
 *    undeclared argument keys are rejected, never ignored; field
 *    failures surface the drafts' field-named messages;
 *  - the gate invariant: a tool-sourced plan executes nothing
 *    unapproved, then runs the full invoice → paid → payout loop.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { LedgerStore } from "../src/lib/agent/store";
import { executePlan, resumeTriggeredSteps } from "../src/lib/agent/executor";
import { draftInvoicePlan, draftOrderPlan, draftPayoutPlan, draftReminderPlan } from "../src/lib/agent/drafts";
import {
  AGENT_TOOLS,
  ToolCallError,
  getAgentTool,
  listAgentTools,
  parseToolCall,
  toolCallToPlan,
  toolCallsToPlan,
} from "../src/lib/agent/tools";

const ROOT = path.join(__dirname, "..");

describe("agent tool definitions — the tool-call-shaped action layer", () => {
  it("defines exactly the four typed actions, in action order", () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual(["create_invoice", "create_order", "draft_payout", "send_reminder"]);
    for (const tool of AGENT_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.description).toContain("pending-approval");
      expect(getAgentTool(tool.name)).toBe(tool);
    }
    expect(getAgentTool("capture_order")).toBeUndefined();
    expect(getAgentTool("")).toBeUndefined();
  });

  it("every input schema is a closed object schema with the drafts' field rules", () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    const invoice = getAgentTool("create_invoice")!;
    expect(invoice.inputSchema.required).toEqual(["recipientName", "amount", "description"]);
    expect(invoice.inputSchema.properties.amount).toMatchObject({ type: "number", exclusiveMinimum: 0, maximum: 100_000 });
    expect(invoice.inputSchema.properties.currency).toMatchObject({ enum: ["USD", "EUR", "GBP"] });
    expect(invoice.inputSchema.properties.dueDate).toMatchObject({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

    const order = getAgentTool("create_order")!;
    expect(order.inputSchema.required).toEqual(["description", "amount"]);

    const reminder = getAgentTool("send_reminder")!;
    expect(reminder.inputSchema.required).toEqual(["recipientName"]);
    expect(Object.keys(reminder.inputSchema.properties)).toEqual(["recipientName", "recipientEmail", "invoiceRef"]);

    const payout = getAgentTool("draft_payout")!;
    expect(payout.inputSchema.required).toBeUndefined();
    expect(payout.inputSchema.anyOf).toEqual([{ required: ["recipientName", "amount"] }, { required: ["items"] }]);
    expect(payout.inputSchema.properties.items).toMatchObject({ type: "array", minItems: 1, maxItems: 25 });
  });

  it("listAgentTools returns a defensive copy — mutating it cannot corrupt the definitions", () => {
    const listed = listAgentTools();
    expect(listed).toEqual(JSON.parse(JSON.stringify(AGENT_TOOLS)));
    listed[0]!.inputSchema.properties.amount = { type: "string" };
    listed[0]!.name = "create_order";
    expect(AGENT_TOOLS[0]!.name).toBe("create_invoice");
    expect(AGENT_TOOLS[0]!.inputSchema.properties.amount).toMatchObject({ type: "number" });
  });

  it("a create_invoice tool step is identical to the equivalent draft step", () => {
    const args = { recipientName: "Ana", amount: 450, description: "logo work", dueDate: "2026-10-16" };
    const plan = toolCallToPlan({ name: "create_invoice", arguments: args });
    const draft = draftInvoicePlan(args);
    expect(plan.steps[0]).toEqual(draft.steps[0]);
    expect(plan.status).toBe("pending_approval");
    expect(plan.source).toBe("tool");
    expect(plan.id).toMatch(/^plan-tool-\d{4}$/);
    expect(plan.brief).toBe("Tool calls: create_invoice");
  });

  it("create_order and send_reminder tool steps are identical to the equivalent draft steps", () => {
    const orderArgs = { description: "logo pack", amount: 75, currency: "eur", reference: "LP-SALE-001" };
    expect(toolCallToPlan({ name: "create_order", arguments: orderArgs }).steps[0]).toEqual(draftOrderPlan(orderArgs).steps[0]);

    const reminderArgs = { recipientName: "Marco" };
    expect(toolCallToPlan({ name: "send_reminder", arguments: reminderArgs }).steps[0]).toEqual(
      draftReminderPlan(reminderArgs).steps[0],
    );
    const refArgs = { recipientName: "Marco", invoiceRef: "LP-000123" };
    expect(toolCallToPlan({ name: "send_reminder", arguments: refArgs }).steps[0]).toEqual(draftReminderPlan(refArgs).steps[0]);
  });

  it("draft_payout tool steps match the drafts for single, invoice-gated, and batch forms", () => {
    const single = { recipientName: "Marco", amount: 200 };
    expect(toolCallToPlan({ name: "draft_payout", arguments: single }).steps[0]).toEqual(draftPayoutPlan(single).steps[0]);

    const gated = { recipientName: "Marco", amount: 120, payWhenInvoicePaid: "INV2-000001" };
    const gatedStep = toolCallToPlan({ name: "draft_payout", arguments: gated }).steps[0]!;
    expect(gatedStep).toEqual(draftPayoutPlan(gated).steps[0]);
    expect(gatedStep.trigger).toEqual({ on: "INVOICING.INVOICE.PAID", resourceId: "INV2-000001" });

    const batch = {
      items: [
        { recipientName: "Marco", amount: 200 },
        { recipientName: "Ana", amount: 50.5, currency: "EUR" },
      ],
    };
    expect(toolCallToPlan({ name: "draft_payout", arguments: batch }).steps[0]).toEqual(draftPayoutPlan(batch).steps[0]);
  });

  it("gatedOnInvoicePaid gives the parser-form trigger: unbound, bound at execution", () => {
    const step = toolCallToPlan({
      name: "draft_payout",
      arguments: { recipientName: "Marco", amount: 200, gatedOnInvoicePaid: true },
    }).steps[0]!;
    expect(step.trigger).toEqual({ on: "INVOICING.INVOICE.PAID" });
    expect(step.trigger!.resourceId).toBeUndefined();
    expect(step.description).toContain("only after the invoice payment lands");
    expect(step.payload).toEqual(draftPayoutPlan({ recipientName: "Marco", amount: 200 }).steps[0]!.payload);
  });

  it("the envelope rejects unknown tools, bad shapes, and undeclared argument keys", () => {
    expect(() => parseToolCall(null)).toThrow(ToolCallError);
    expect(() => parseToolCall({ arguments: {} })).toThrow(/'name'/);
    expect(() => parseToolCall({ name: "refund_everything", arguments: {} })).toThrow(/not a LedgerPilot tool/);
    expect(() => parseToolCall({ name: "create_order", arguments: [] })).toThrow(/'arguments' must be an object/);
    expect(() =>
      parseToolCall({ name: "create_order", arguments: { description: "x", amount: 5, executeImmediately: true } }),
    ).toThrow(/unknown argument 'executeImmediately'/);
    // Every declared schema property IS an accepted argument (schema/validator agreement).
    for (const tool of AGENT_TOOLS) {
      for (const key of Object.keys(tool.inputSchema.properties)) {
        expect(() => parseToolCall({ name: tool.name, arguments: { [key]: undefined } })).not.toThrow(/unknown argument/);
      }
    }
  });

  it("field validation is the drafts': field-named ToolCallErrors, no half-valid plan", () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ name: "create_invoice", arguments: { amount: 450, description: "logo work" } }, /'recipientName' is required/],
      [{ name: "create_invoice", arguments: { recipientName: "Ana", amount: 0, description: "logo work" } }, /'amount' must be greater than zero/],
      [{ name: "create_order", arguments: { description: "pack", amount: 75, currency: "JPY" } }, /'currency' must be one of USD, EUR, GBP/],
      [
        { name: "create_invoice", arguments: { recipientName: "Ana", amount: 450, description: "logo work", dueDate: "2026-02-30" } },
        /'dueDate' must be a real calendar date/,
      ],
      [{ name: "draft_payout", arguments: { recipientName: "Marco", amount: 200, gatedOnInvoicePaid: "yes" } }, /'gatedOnInvoicePaid' must be a boolean/],
      [
        { name: "draft_payout", arguments: { recipientName: "Marco", amount: 200, gatedOnInvoicePaid: true, payWhenInvoicePaid: "INV2-000001" } },
        /pass one, not both/,
      ],
    ];
    for (const [call, pattern] of bad) {
      expect(() => toolCallToPlan(call), JSON.stringify(call)).toThrow(ToolCallError);
      expect(() => toolCallToPlan(call), JSON.stringify(call)).toThrow(pattern);
    }
  });

  it("multi-call plans combine steps under one gate, capped at four calls", () => {
    const plan = toolCallsToPlan([
      { name: "create_invoice", arguments: { recipientName: "Ana", amount: 450, description: "brand work", dueDate: "2026-10-16" } },
      { name: "draft_payout", arguments: { recipientName: "Marco", amount: 200, gatedOnInvoicePaid: true } },
    ]);
    expect(plan.steps.map((s) => s.type)).toEqual(["create_invoice", "draft_payout"]);
    expect(plan.brief).toBe("Tool calls: create_invoice + draft_payout");
    expect(plan.source).toBe("tool");

    expect(() => toolCallsToPlan([])).toThrow(/At least one tool call/);
    expect(() => toolCallsToPlan("create_invoice")).toThrow(/At least one tool call/);
    const five = Array.from({ length: 5 }, () => ({ name: "create_order", arguments: { description: "x", amount: 1 } }));
    expect(() => toolCallsToPlan(five)).toThrow(/at most 4 tool calls/);
  });

  it("a tool-sourced plan executes nothing unapproved, then closes the full loop", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    const plan = store.addPlan(
      toolCallsToPlan([
        { name: "create_invoice", arguments: { recipientName: "Ana", amount: 450, description: "brand work", dueDate: "2026-10-16" } },
        { name: "draft_payout", arguments: { recipientName: "Marco", amount: 200, gatedOnInvoicePaid: true } },
      ]),
    );
    await expect(executePlan(store, client, plan.id)).rejects.toThrow(/approval/);
    expect(await client.listInvoices()).toHaveLength(0);

    store.approvePlan(plan.id);
    const executed = await executePlan(store, client, plan.id);
    expect(executed.plan.status).toBe("awaiting_trigger");
    const invoices = await client.listInvoices();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ status: "SENT" });
    expect(await client.listPayouts()).toHaveLength(0);

    await client.recordInvoicePayment(invoices[0]!.id, { value: "450.00", currency_code: "USD" });
    const resumed = await resumeTriggeredSteps(store, client, "INVOICING.INVOICE.PAID", invoices[0]!.id);
    expect(resumed.map((r) => r.plan.id)).toEqual([plan.id]);
    expect(store.getPlan(plan.id)!.status).toBe("completed");
    const payouts = await client.listPayouts();
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.items[0]).toMatchObject({ transaction_status: "SUCCESS" });
    const transactions = await client.listTransactions();
    expect(transactions.map((t) => t.transaction_amount.value)).toEqual(expect.arrayContaining(["450.00", "-200.00"]));
  });

  it("the README documents the tool layer and its route", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
    expect(readme).toContain("Agent tool definitions");
    expect(readme).toContain("/api/agent/tools");
    expect(readme).toContain('source: "tool"');
  });
});
