import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { LedgerStore } from "../src/lib/agent/store";
import { executePlan } from "../src/lib/agent/executor";
import { DraftValidationError, draftReminderPlan, parseBrief } from "../src/lib/agent";
import { seedJudgeScenario } from "../src/lib/judge";
import {
  EXAMPLE_REMINDER_FORM,
  buildReminderRequestBody,
  emptyReminderForm,
  reminderFieldError,
  reminderPreviewSummary,
  validateReminderForm,
} from "../src/lib/reminder";

/**
 * Reminder form + draft wrapper (CONCEPT.md §1 AI component:
 * AI-drafted payment reminders; §3.1's typed action `send_reminder`).
 *
 * `send_reminder` was the one typed action with no structured draft
 * and no console form — reachable only via an NL brief or the LLM
 * fallback, while create_invoice / create_order / draft_payout each
 * had both. These tests pin the new data path (draftReminderPlan,
 * parser-identical step, gate invariant) and the form's pure
 * view-model (validation mirror, request body, preview), plus the
 * full gated loop against Judge Mode's seeded history.
 */

const NOW = new Date("2026-10-10T12:00:00Z");

describe("reminder draft — parser-identical step", () => {
  it("with no reference, the API draft's step is identical to the parser's most-overdue step", () => {
    const parsed = parseBrief("Remind Marco about his overdue invoice", { now: NOW });
    const drafted = draftReminderPlan({ recipientName: "Marco" });
    expect(drafted.status).toBe("pending_approval");
    expect(drafted.source).toBe("api");
    expect(drafted.id).toMatch(/^plan-api-/);
    expect(drafted.steps[0]).toEqual(parsed.steps[0]);
  });

  it("with an explicit reference, the API draft's step is identical to the parser's referenced step", () => {
    const parsed = parseBrief("Remind Ana about invoice LP-000123", { now: NOW });
    const drafted = draftReminderPlan({ recipientName: "Ana", invoiceRef: "LP-000123" });
    expect(drafted.steps[0]).toEqual(parsed.steps[0]);
    expect(drafted.steps[0]!.paypalCall).toEqual({ method: "POST", path: "/v2/invoicing/invoices/:id/remind" });
  });

  it("an explicit recipient email wins over the demo contact book", () => {
    const drafted = draftReminderPlan({ recipientName: "Ana", recipientEmail: "ana@studio.example" });
    expect((drafted.steps[0]!.payload as { recipient: { email_address: string } }).recipient.email_address).toBe(
      "ana@studio.example",
    );
  });

  it("rejects invalid drafts with a 400 DraftValidationError naming the field", () => {
    const cases: Array<[unknown, RegExp]> = [
      [{}, /'recipientName' is required/],
      [{ recipientName: " " }, /'recipientName' is required/],
      [{ recipientName: "x".repeat(501) }, /'recipientName' must be at most 500/],
      [{ recipientName: "Ana", recipientEmail: "not-an-email" }, /'recipientEmail' must be a valid email address/],
      [{ recipientName: "Ana", invoiceRef: "x".repeat(501) }, /'invoiceRef' must be at most 500/],
      [{ recipientName: "Ana", invoiceRef: 42 }, /'invoiceRef' is required/],
    ];
    for (const [input, pattern] of cases) {
      try {
        draftReminderPlan(input as never);
        expect.unreachable(`expected DraftValidationError for ${JSON.stringify(input)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(DraftValidationError);
        expect((err as DraftValidationError).status).toBe(400);
        expect((err as Error).message).toMatch(pattern);
      }
    }
  });
});

describe("reminder form — view-model", () => {
  it("starts empty and the example is the Marco most-overdue reminder", () => {
    expect(emptyReminderForm()).toEqual({ recipientName: "", recipientEmail: "", invoiceRef: "" });
    expect(EXAMPLE_REMINDER_FORM).toEqual({ recipientName: "Marco", recipientEmail: "", invoiceRef: "" });
  });

  it("validation mirror names the failing field for every server rule", () => {
    const v = validateReminderForm({ recipientName: " ", recipientEmail: "not-an-email", invoiceRef: "x".repeat(501) });
    expect(v.ok).toBe(false);
    expect(reminderFieldError(v, "recipientName")).toMatch(/'recipientName' is required/);
    expect(reminderFieldError(v, "recipientEmail")).toMatch(/valid email address/);
    expect(reminderFieldError(v, "invoiceRef")).toMatch(/at most 500/);
    expect(validateReminderForm(EXAMPLE_REMINDER_FORM).ok).toBe(true);
    expect(validateReminderForm({ recipientName: "Ana", recipientEmail: "", invoiceRef: "LP-000123" }).ok).toBe(true);
    expect(reminderFieldError(validateReminderForm(EXAMPLE_REMINDER_FORM), "recipientName")).toBeNull();
  });

  it("builds the server body: trims, and omits empty optionals instead of sending empty strings", () => {
    expect(buildReminderRequestBody(EXAMPLE_REMINDER_FORM)).toEqual({ recipientName: "Marco" });
    expect(
      buildReminderRequestBody({ recipientName: " Ana ", recipientEmail: " ana@example.com ", invoiceRef: " LP-000123 " }),
    ).toEqual({ recipientName: "Ana", recipientEmail: "ana@example.com", invoiceRef: "LP-000123" });
  });

  it("preview states the targeting rule and never claims a resolved invoice", () => {
    expect(reminderPreviewSummary(EXAMPLE_REMINDER_FORM)).toBe("Remind Marco · most-overdue open invoice");
    expect(reminderPreviewSummary({ recipientName: "Ana", recipientEmail: "", invoiceRef: "LP-000123" })).toBe(
      "Remind Ana · about invoice LP-000123",
    );
    expect(reminderPreviewSummary(emptyReminderForm())).toBe("Remind Unnamed recipient · most-overdue open invoice");
  });

  it("the example validates and its form-built body is accepted by the real server draft", () => {
    expect(validateReminderForm(EXAMPLE_REMINDER_FORM).ok).toBe(true);
    const plan = draftReminderPlan(buildReminderRequestBody(EXAMPLE_REMINDER_FORM));
    expect(plan.status).toBe("pending_approval");
    expect(plan.source).toBe("api");
    expect(plan.steps[0]!.type).toBe("send_reminder");
  });
});

describe("reminder form — full loop through the gate (Judge Mode history)", () => {
  it("drafting sends nothing; approve → execute reminds Marco about the seeded overdue invoice", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    const seeded = await seedJudgeScenario(client, store, { now: NOW });
    const marcoOverdueId = seeded.seed.invoiceIds[1]!; // PARTIALLY_PAID, due 2026-10-01

    const plan = store.addPlan(draftReminderPlan(buildReminderRequestBody(EXAMPLE_REMINDER_FORM)));
    expect(client.sentReminders).toHaveLength(0);
    await expect(executePlan(store, client, plan.id)).rejects.toThrow(/approval/);
    expect(client.sentReminders).toHaveLength(0);

    store.approvePlan(plan.id);
    const result = await executePlan(store, client, plan.id);
    expect(result.plan.status).toBe("completed");
    expect(result.outcomes[0]).toMatchObject({ outcome: "executed", resultId: marcoOverdueId });
    expect(client.sentReminders).toHaveLength(1);
    expect(client.sentReminders[0]).toMatchObject({ invoiceId: marcoOverdueId });
  });

  it("a form-built draft naming an invoice by number sends to exactly that invoice; an unmatched reference fails", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    const seeded = await seedJudgeScenario(client, store, { now: NOW });
    const samInvoice = (await client.listInvoices()).find((i) => i.id === seeded.seed.invoiceIds[2])!;
    expect(samInvoice.detail.invoice_number).toBeTruthy();

    const named = store.addPlan(
      draftReminderPlan({ recipientName: "Sam Rivera", invoiceRef: samInvoice.detail.invoice_number }),
    );
    store.approvePlan(named.id);
    const namedResult = await executePlan(store, client, named.id);
    expect(namedResult.plan.status).toBe("completed");
    expect(client.sentReminders.map((r) => r.invoiceId)).toEqual([samInvoice.id]);

    const bad = store.addPlan(draftReminderPlan({ recipientName: "Ana", invoiceRef: "LP-999999" }));
    store.approvePlan(bad.id);
    const badResult = await executePlan(store, client, bad.id);
    expect(badResult.plan.status).toBe("failed");
    expect(badResult.outcomes[0]!.error).toContain('No invoice matches "LP-999999"');
    expect(client.sentReminders).toHaveLength(1);
  });
});
