import { describe, expect, it } from "vitest";
import { LedgerStore, executePlan, parseBrief } from "@/lib/agent";
import { seedJudgeScenario } from "@/lib/judge";
import { MockPayPalClient, PayPalError } from "@/lib/paypal";
import type { Party } from "@/lib/types";

/**
 * Invoice reminders — the send_reminder step used to stop at an
 * auditable *draft* because the adapter contract had no remind call.
 * These tests pin the real behavior end to end: the adapter method
 * (mock rules), the parser's reference handling, the executor's
 * deterministic invoice resolution, and the Judge Mode example path.
 */

const NOW = new Date("2026-10-10T12:00:00Z");
const ANA: Party = { name: "Ana", email_address: "ana@example.com" };
const MARCO: Party = { name: "Marco", email_address: "marco@example.com" };

async function openInvoice(
  client: MockPayPalClient,
  recipient: Party,
  value: string,
  dueDate: string,
  currency: "USD" | "EUR" = "USD",
) {
  const draft = await client.createInvoice({
    recipient,
    items: [{ name: "Work", quantity: "1", unit_amount: { currency_code: currency, value } }],
    dueDate,
  });
  return client.sendInvoice(draft.id);
}

async function runReminderBrief(client: MockPayPalClient, brief: string, planId: string) {
  const store = new LedgerStore();
  const plan = store.addPlan(parseBrief(brief, { now: NOW, planId }));
  store.approvePlan(plan.id);
  const result = await executePlan(store, client, plan.id);
  return { store, plan, result };
}

describe("mock adapter — sendInvoiceReminder", () => {
  it("sends for SENT and PARTIALLY_PAID invoices and records each reminder", async () => {
    const client = new MockPayPalClient();
    const sent = await openInvoice(client, ANA, "300.00", "2026-10-20");
    const reminded = await client.sendInvoiceReminder(sent.id, { subject: "Reminder: invoice due" });
    expect(reminded.id).toBe(sent.id);
    expect(reminded.status).toBe("SENT");

    await client.recordInvoicePayment(sent.id, { value: "100.00", currency_code: "USD" });
    const partial = await client.getInvoice(sent.id);
    expect(partial.status).toBe("PARTIALLY_PAID");
    await client.sendInvoiceReminder(sent.id);
    expect(client.sentReminders).toHaveLength(2);
    expect(client.sentReminders[0]).toMatchObject({
      invoiceId: sent.id,
      recipient: ANA,
      subject: "Reminder: invoice due",
    });
    expect(client.sentReminders[1]!.invoiceId).toBe(sent.id);
  });

  it("refuses DRAFT and PAID invoices with a 422, and unknown ids with a 404", async () => {
    const client = new MockPayPalClient();
    const draft = await client.createInvoice({
      recipient: ANA,
      items: [{ name: "Work", quantity: "1", unit_amount: { currency_code: "USD", value: "50.00" } }],
    });
    await expect(client.sendInvoiceReminder(draft.id)).rejects.toMatchObject({ status: 422 });
    await expect(client.sendInvoiceReminder(draft.id)).rejects.toBeInstanceOf(PayPalError);

    const sent = await client.sendInvoice(draft.id);
    await client.recordInvoicePayment(sent.id, { value: "50.00", currency_code: "USD" });
    expect((await client.getInvoice(sent.id)).status).toBe("PAID");
    await expect(client.sendInvoiceReminder(sent.id)).rejects.toMatchObject({ status: 422 });
    await expect(client.sendInvoiceReminder("INV2-999999")).rejects.toMatchObject({ status: 404 });
    expect(client.sentReminders).toHaveLength(0);
  });
});

describe("parser — reminder references", () => {
  it("keeps a real invoice reference and strips trailing punctuation", () => {
    const plan = parseBrief("Remind Ana about invoice LP-000123.", { now: NOW });
    expect(plan.steps[0]!.type).toBe("send_reminder");
    expect((plan.steps[0]!.payload as { invoiceRef: string | null }).invoiceRef).toBe("LP-000123");
    expect(plan.steps[0]!.description).toContain("Send a payment reminder");
  });

  it("treats conversational phrasing as no reference — the executor resolves the open invoice", () => {
    const plan = parseBrief("Remind Marco about his overdue invoice", { now: NOW });
    expect(plan.steps[0]!.type).toBe("send_reminder");
    expect((plan.steps[0]!.payload as { invoiceRef: string | null }).invoiceRef).toBeNull();
    expect(plan.steps[0]!.description).toContain("most-overdue open invoice");
  });
});

describe("executor — reminder resolution and the real remind call", () => {
  it("reminds by invoice number: plan completes, the adapter recorded the send, the audit shows the call", async () => {
    const client = new MockPayPalClient();
    const sent = await openInvoice(client, ANA, "300.00", "2026-10-20");
    const { store, result } = await runReminderBrief(
      client,
      `Remind Ana about invoice ${sent.detail.invoice_number}`,
      "plan-remind-by-number",
    );
    expect(result.plan.status).toBe("completed");
    expect(result.outcomes[0]).toMatchObject({ outcome: "executed", resultId: sent.id });
    expect(client.sentReminders).toHaveLength(1);
    expect(client.sentReminders[0]!.invoiceId).toBe(sent.id);
    const audit = store.listActivity(result.plan.id).map((a) => a.summary).join("\n");
    expect(audit).toContain(`/v2/invoicing/invoices/${sent.id}/remind`);
    expect(audit).toContain("reminder sent to Ana");
    expect(audit).not.toContain("draft");
  });

  it("with no reference, picks the recipient's most-overdue open invoice (earliest due date)", async () => {
    const client = new MockPayPalClient();
    const later = await openInvoice(client, MARCO, "100.00", "2026-11-01", "EUR");
    const earlier = await openInvoice(client, MARCO, "300.00", "2026-10-01", "EUR");
    await openInvoice(client, ANA, "999.00", "2026-09-01"); // earlier still, wrong recipient
    const { result } = await runReminderBrief(client, "Remind Marco about his overdue invoice", "plan-remind-most-overdue");
    expect(result.plan.status).toBe("completed");
    expect(result.outcomes[0]!.resultId).toBe(earlier.id);
    expect(result.outcomes[0]!.resultId).not.toBe(later.id);
    expect(client.sentReminders.map((r) => r.invoiceId)).toEqual([earlier.id]);
  });

  it("an unmatched reference fails the step — no reminder sent, nothing downgraded to a draft", async () => {
    const client = new MockPayPalClient();
    await openInvoice(client, ANA, "300.00", "2026-10-20");
    const { store, result } = await runReminderBrief(client, "Remind Ana about invoice LP-999999", "plan-remind-bad-ref");
    expect(result.plan.status).toBe("failed");
    expect(result.outcomes[0]).toMatchObject({ outcome: "failed" });
    expect(result.outcomes[0]!.error).toContain('No invoice matches "LP-999999"');
    expect(client.sentReminders).toHaveLength(0);
    const audit = store.listActivity(result.plan.id).map((a) => a.summary).join("\n");
    expect(audit).not.toContain("/remind → reminder sent");
  });

  it("fails honestly when the recipient has no open invoice, and when the named invoice is already PAID", async () => {
    const client = new MockPayPalClient();
    const noOpen = await runReminderBrief(client, "Remind Ana", "plan-remind-none");
    expect(noOpen.result.plan.status).toBe("failed");
    expect(noOpen.result.outcomes[0]!.error).toContain("No open invoice for Ana");

    const sent = await openInvoice(client, ANA, "50.00", "2026-10-20");
    await client.recordInvoicePayment(sent.id, { value: "50.00", currency_code: "USD" });
    const paid = await runReminderBrief(
      client,
      `Remind Ana about invoice ${sent.detail.invoice_number}`,
      "plan-remind-paid",
    );
    expect(paid.result.plan.status).toBe("failed");
    expect(paid.result.outcomes[0]!.error).toContain("cannot be reminded from status PAID");
    expect(client.sentReminders).toHaveLength(0);
  });

  it("the approval gate still applies: an unapproved reminder plan sends nothing", async () => {
    const client = new MockPayPalClient();
    await openInvoice(client, ANA, "300.00", "2026-10-20");
    const store = new LedgerStore();
    const plan = store.addPlan(parseBrief("Remind Ana", { now: NOW, planId: "plan-remind-gated" }));
    await expect(executePlan(store, client, plan.id)).rejects.toThrow(/requires approval/);
    expect(client.sentReminders).toHaveLength(0);
  });

  it("Judge Mode: the command-bar example brief reminds Marco about the seeded overdue invoice", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    const seeded = await seedJudgeScenario(client, store, { now: NOW });
    const marcoOverdueId = seeded.seed.invoiceIds[1]!; // PARTIALLY_PAID, due 2026-10-01
    const plan = store.addPlan(parseBrief("Remind Marco about his overdue invoice", { now: NOW, planId: "plan-remind-judge" }));
    store.approvePlan(plan.id);
    const result = await executePlan(store, client, plan.id);
    expect(result.plan.status).toBe("completed");
    expect(result.outcomes[0]!.resultId).toBe(marcoOverdueId);
    expect(client.sentReminders).toHaveLength(1);
    expect(client.sentReminders[0]).toMatchObject({ invoiceId: marcoOverdueId, recipient: MARCO });
  });
});
