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
 */

import type { PayPalClient } from "../paypal/client";
import type {
  ActionPlan,
  ActionStep,
  CreateInvoiceInput,
  CreateOrderInput,
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
    // send_reminder: the adapter contract has no remind call yet (the real
    // endpoint is POST /v2/invoicing/invoices/:id/remind). Until the sandbox
    // milestone adds it, execution produces the drafted reminder as an
    // auditable activity record — labeled as a draft, never as "sent".
    const recipient = p.recipient as Party;
    store.record({
      planId: plan.id,
      kind: "paypal_call",
      summary: `Reminder drafted for ${recipient.name}${p.invoiceRef ? ` (invoice ${String(p.invoiceRef)})` : ""} — draft only, reminder send lands with the sandbox adapter`,
      detail: { drafted: true, recipient: recipient.email_address },
    });
    return { step, outcome: "executed" };
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
    outcomes.push(await runStep(client, store, plan, step));
  }
  return { plan: finishPlan(store, plan, outcomes), outcomes };
}

/**
 * Run the deferred steps of every `awaiting_trigger` plan whose trigger
 * matches the event that just arrived. Returns one result per resumed plan.
 */
export async function resumeTriggeredSteps(
  store: LedgerStore,
  client: PayPalClient,
  eventType: WebhookEventType,
): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];
  for (const plan of store.listPlans()) {
    if (plan.status !== "awaiting_trigger") continue;
    const due = plan.steps.filter((s) => s.trigger?.on === eventType);
    if (due.length === 0) continue;
    store.updatePlanStatus(plan.id, "executing");
    store.record({ planId: plan.id, kind: "webhook", summary: `Trigger ${eventType} received — resuming ${due.length} deferred step(s) of plan ${plan.id}` });
    const outcomes: StepOutcome[] = [];
    const newSteps = [...plan.steps];
    for (const [i, step] of plan.steps.entries()) {
      if ((step.payload as Record<string, unknown>)._executed) continue; // ran in an earlier pass
      if (step.trigger?.on !== eventType) {
        // Steps with a different trigger stay deferred; already-run
        // immediate steps are not re-executed.
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
