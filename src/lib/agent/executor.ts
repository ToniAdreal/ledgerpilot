/**
 * Plan executor — the only path from an approved plan to PayPal calls.
 *
 * Invariants (the product's trust story, CONCEPT.md §3.1):
 *  - Nothing executes unless the plan is `approved` in the store.
 *  - Every step writes an activity record before/after its PayPal call.
 *  - A step with a trigger (e.g. a payout gated on INVOICING.INVOICE.PAID)
 *    is deferred, never executed early; `resumeTriggeredSteps` runs it
 *    when the matching event arrives (called by the webhook handler /
 *    sync reconciler in the next core-loop chunk).
 *  - Trigger resumption is resource-correlated: executing a plan binds
 *    its invoice-gated steps to the invoice that plan itself created
 *    (`trigger.resourceId`), and a later event only resumes the step
 *    when the event's resource id matches the binding. An event for a
 *    *different* invoice — out-of-order delivery, another plan's
 *    payment, seeded history — never fires this plan's payout. Events
 *    that carry no resource id fall back to type-only matching so the
 *    reconciler's synthetic events and direct callers keep working.
 */

import type { PayPalClient } from "../paypal/client";
import type {
  ActionPlan,
  ActionStep,
  CreateInvoiceInput,
  CreateOrderInput,
  Invoice,
  Party,
  Money,
  WebhookEventType,
} from "../types";
import type { LedgerStore } from "./store";

export interface StepOutcome {
  step: ActionStep;
  outcome: "executed" | "deferred" | "failed";
  resultId?: string;
  error?: string;
}

export interface ExecutionResult {
  plan: ActionPlan;
  outcomes: StepOutcome[];
}

async function runStep(
  client: PayPalClient,
  store: LedgerStore,
  plan: ActionPlan,
  step: ActionStep,
): Promise<StepOutcome> {
  const p = step.payload as Record<string, unknown>;
  try {
    if (step.type === "create_invoice") {
      const invoice = await client.createInvoice(p as unknown as CreateInvoiceInput);
      const sent = await client.sendInvoice(invoice.id);
      store.record({
        planId: plan.id,
        kind: "paypal_call",
        summary: `POST /v2/invoicing/invoices → ${sent.id} created and sent (${sent.status}), ${sent.amount.currency_code} ${sent.amount.value}`,
        detail: { invoiceId: sent.id, status: sent.status },
      });
      return { step, outcome: "executed", resultId: sent.id };
    }
    if (step.type === "create_order") {
      const order = await client.createOrder(p as unknown as CreateOrderInput);
      store.record({
        planId: plan.id,
        kind: "paypal_call",
        summary: `POST /v2/checkout/orders → ${order.id} created (${order.status})`,
        detail: { orderId: order.id, status: order.status },
      });
      return { step, outcome: "executed", resultId: order.id };
    }
    if (step.type === "draft_payout") {
      const amount = p.amount as Money;
      const recipient = p.recipient as Party;
      const batch = await client.createPayout({
        items: [{ recipient, amount, note: (p.note as string) ?? undefined }],
      });
      store.record({
        planId: plan.id,
        kind: "paypal_call",
        summary: `POST /v1/payments/payouts → batch ${batch.batch_header.payout_batch_id} (${batch.batch_header.batch_status}), ${amount.currency_code} ${amount.value} to ${recipient.name}`,
        detail: { payoutBatchId: batch.batch_header.payout_batch_id, status: batch.batch_header.batch_status },
      });
      return { step, outcome: "executed", resultId: batch.batch_header.payout_batch_id };
    }
    // send_reminder: resolve the target invoice, then call the real
    // remind endpoint through the adapter. Resolution is deterministic:
    //  - an explicit reference must match an invoice id, invoice number,
    //    or detail reference — a reference that matches nothing fails the
    //    step (a reminder is never sent to the wrong invoice, and never
    //    silently downgraded to a "draft");
    //  - with no reference, the recipient's open invoices (SENT /
    //    PARTIALLY_PAID / SCHEDULED) are considered and the most overdue
    //    wins: earliest due date first, undated invoices last, list order
    //    breaks ties. No open invoice for the recipient fails the step.
    // The adapter itself refuses non-open invoices (e.g. a PAID invoice
    // named by reference), so those surface as failed steps too.
    const recipient = p.recipient as Party;
    const ref = typeof p.invoiceRef === "string" && p.invoiceRef ? p.invoiceRef : null;
    const invoices = await client.listInvoices();
    let target: Invoice | undefined;
    if (ref) {
      target = invoices.find(
        (i) => i.id === ref || i.detail.invoice_number === ref || i.detail.reference === ref,
      );
      if (!target) {
        throw new Error(
          `No invoice matches "${ref}" — the reminder was not sent. Check the invoice number, or drop the reference to remind ${recipient.name} about their most-overdue open invoice.`,
        );
      }
    } else {
      const open = invoices.filter(
        (i) =>
          (i.status === "SENT" || i.status === "PARTIALLY_PAID" || i.status === "SCHEDULED") &&
          i.primary_recipients.some(
            (r) => r.billing_info.email_address.toLowerCase() === recipient.email_address.toLowerCase(),
          ),
      );
      if (open.length === 0) {
        throw new Error(
          `No open invoice for ${recipient.name} (${recipient.email_address}) — there is nothing to remind about, so no reminder was sent.`,
        );
      }
      target = [...open].sort((a, b) => {
        const da = a.detail.payment_term?.due_date ?? "9999-12-31";
        const db = b.detail.payment_term?.due_date ?? "9999-12-31";
        return da < db ? -1 : da > db ? 1 : 0;
      })[0];
    }
    const reminded = await client.sendInvoiceReminder(target!.id, {
      subject: `Reminder: invoice ${target!.detail.invoice_number} is due`,
      note: `Payment reminder for invoice ${target!.detail.invoice_number} — ${target!.due_amount.currency_code} ${target!.due_amount.value} still due.`,
    });
    store.record({
      planId: plan.id,
      kind: "paypal_call",
      summary: `POST /v2/invoicing/invoices/${reminded.id}/remind → reminder sent to ${recipient.name} for invoice ${reminded.detail.invoice_number} (${reminded.due_amount.currency_code} ${reminded.due_amount.value} due, status ${reminded.status})`,
      detail: { invoiceId: reminded.id, invoiceNumber: reminded.detail.invoice_number, reminded: true, recipient: recipient.email_address },
    });
    return { step, outcome: "executed", resultId: reminded.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.record({ planId: plan.id, kind: "system", summary: `Step failed (${step.type}): ${message}` });
    return { step, outcome: "failed", error: message };
  }
}

function finishPlan(store: LedgerStore, plan: ActionPlan, outcomes: StepOutcome[]): ActionPlan {
  const failed = outcomes.some((o) => o.outcome === "failed");
  const deferred = outcomes.some((o) => o.outcome === "deferred");
  const status = failed ? "failed" : deferred ? "awaiting_trigger" : "completed";
  return store.updatePlanStatus(plan.id, status);
}

export async function executePlan(store: LedgerStore, client: PayPalClient, planId: string): Promise<ExecutionResult> {
  const plan = store.getPlan(planId);
  if (!plan) throw new Error(`Unknown plan: ${planId}`);
  if (plan.status !== "approved") {
    throw new Error(`Plan ${planId} is ${plan.status} — execution requires approval first`);
  }
  store.updatePlanStatus(planId, "executing");
  store.record({ planId, kind: "system", summary: `Executing plan ${planId} (${plan.steps.length} steps)` });

  const outcomes: StepOutcome[] = [];
  let invoiceResultId: string | undefined;
  for (const step of plan.steps) {
    if (step.trigger) {
      store.record({
        planId,
        kind: "system",
        summary: `Deferred until ${step.trigger.on}: ${step.description}`,
        detail: { trigger: step.trigger.on },
      });
      outcomes.push({ step, outcome: "deferred" });
      continue;
    }
    const outcome = await runStep(client, store, plan, step);
    if (step.type === "create_invoice" && outcome.outcome === "executed") {
      invoiceResultId = outcome.resultId;
    }
    outcomes.push(outcome);
  }

  // Bind invoice-gated deferred steps to the invoice THIS plan created,
  // so only that invoice's payment event can ever release them.
  if (invoiceResultId) {
    let changed = false;
    const boundSteps = plan.steps.map((s) => {
      if (s.trigger?.on === "INVOICING.INVOICE.PAID" && !s.trigger.resourceId) {
        changed = true;
        return { ...s, trigger: { ...s.trigger, resourceId: invoiceResultId } };
      }
      return s;
    });
    if (changed) store.replacePlanSteps(planId, boundSteps);
  }
  return { plan: finishPlan(store, plan, outcomes), outcomes };
}

/** Does this step's trigger match the event? Type must match; when both
 * the step is bound to a resource and the event names one, they must be
 * the same resource. Unbound steps / id-less events match on type. */
function triggerMatches(step: ActionStep, eventType: WebhookEventType, resourceId?: string): boolean {
  if (step.trigger?.on !== eventType) return false;
  if (resourceId === undefined || step.trigger.resourceId === undefined) return true;
  return step.trigger.resourceId === resourceId;
}

/**
 * Run the deferred steps of every `awaiting_trigger` plan whose trigger
 * matches the event that just arrived. Returns one result per resumed plan.
 * A plan whose gated steps are bound to a different resource is left
 * untouched (and the mismatch is written to the audit log) — never resumed.
 */
export async function resumeTriggeredSteps(
  store: LedgerStore,
  client: PayPalClient,
  eventType: WebhookEventType,
  resourceId?: string,
): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];
  for (const plan of store.listPlans()) {
    if (plan.status !== "awaiting_trigger") continue;
    const typed = plan.steps.filter(
      (s) => s.trigger?.on === eventType && !(s.payload as Record<string, unknown>)._executed,
    );
    if (typed.length === 0) continue;
    const due = typed.filter((s) => triggerMatches(s, eventType, resourceId));
    if (due.length === 0) {
      store.record({
        planId: plan.id,
        kind: "webhook",
        summary: `Trigger ${eventType} for resource ${resourceId} does not match plan ${plan.id}'s bound resource ${typed[0]!.trigger!.resourceId} — deferred step(s) stay gated`,
        detail: { eventType, resourceId, boundResourceId: typed[0]!.trigger!.resourceId },
      });
      continue;
    }
    store.updatePlanStatus(plan.id, "executing");
    store.record({ planId: plan.id, kind: "webhook", summary: `Trigger ${eventType} received — resuming ${due.length} deferred step(s) of plan ${plan.id}` });
    const outcomes: StepOutcome[] = [];
    const newSteps = [...plan.steps];
    for (const [i, step] of plan.steps.entries()) {
      if ((step.payload as Record<string, unknown>)._executed) continue; // ran in an earlier pass
      if (!triggerMatches(step, eventType, resourceId)) {
        // Steps gated on a different event (or a different resource)
        // stay deferred; already-run immediate steps are not re-executed.
        if (step.trigger) outcomes.push({ step, outcome: "deferred" });
        continue;
      }
      const outcome = await runStep(client, store, plan, { ...step, trigger: undefined });
      outcomes.push(outcome);
      if (outcome.outcome === "executed") {
        newSteps[i] = { ...step, trigger: undefined, payload: { ...step.payload, _executed: true } };
      }
    }
    store.replacePlanSteps(plan.id, newSteps);
    results.push({ plan: finishPlan(store, plan, outcomes), outcomes });
  }
  return results;
}
