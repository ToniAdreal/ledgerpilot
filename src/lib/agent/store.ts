/**
 * In-memory ledger store — plans, the append-only activity (audit) log,
 * and the set of webhook event ids already processed.
 *
 * October scope is deliberately storage-thin (SQLite persistence is a
 * later hardening item); the store's *semantics* are the product
 * invariant: every plan, approval, PayPal call, and webhook lands in
 * the activity log, and a webhook event id is processed at most once.
 */

import type { ActionPlan, ActivityRecord } from "../types";

let actSeq = 0;

export class LedgerStore {
  private plans = new Map<string, ActionPlan>();
  private activity: ActivityRecord[] = [];
  private processedEventIds = new Set<string>();

  addPlan(plan: ActionPlan): ActionPlan {
    this.plans.set(plan.id, structuredClone(plan));
    this.record({ planId: plan.id, kind: "plan", summary: `Plan created from brief: "${plan.brief}"`, detail: { steps: plan.steps.length } });
    return structuredClone(plan);
  }

  getPlan(planId: string): ActionPlan | undefined {
    const plan = this.plans.get(planId);
    return plan ? structuredClone(plan) : undefined;
  }

  listPlans(): ActionPlan[] {
    return [...this.plans.values()].map((p) => structuredClone(p));
  }

  updatePlanStatus(planId: string, status: ActionPlan["status"]): ActionPlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Unknown plan: ${planId}`);
    plan.status = status;
    return structuredClone(plan);
  }

  replacePlanSteps(planId: string, steps: ActionPlan["steps"]): ActionPlan {
    const plan = this.mustGet(planId);
    plan.steps = structuredClone(steps);
    return structuredClone(plan);
  }

  approvePlan(planId: string): ActionPlan {
    const plan = this.mustGet(planId);
    if (plan.status !== "pending_approval") {
      throw new Error(`Plan ${planId} cannot be approved from status ${plan.status}`);
    }
    plan.status = "approved";
    this.record({ planId, kind: "approval", summary: `Plan ${planId} approved — execution unlocked` });
    return structuredClone(plan);
  }

  rejectPlan(planId: string): ActionPlan {
    const plan = this.mustGet(planId);
    if (plan.status !== "pending_approval") {
      throw new Error(`Plan ${planId} cannot be rejected from status ${plan.status}`);
    }
    plan.status = "rejected";
    this.record({ planId, kind: "approval", summary: `Plan ${planId} rejected — nothing will execute` });
    return structuredClone(plan);
  }

  record(input: { planId?: string; kind: ActivityRecord["kind"]; summary: string; detail?: Record<string, unknown> }): ActivityRecord {
    actSeq += 1;
    const rec: ActivityRecord = {
      id: `act-${String(actSeq).padStart(6, "0")}`,
      planId: input.planId,
      kind: input.kind,
      summary: input.summary,
      detail: input.detail,
      createdAt: new Date().toISOString(),
    };
    this.activity.push(rec);
    return structuredClone(rec);
  }

  listActivity(planId?: string): ActivityRecord[] {
    const rows = planId ? this.activity.filter((a) => a.planId === planId) : this.activity;
    return rows.map((a) => structuredClone(a));
  }

  /** Webhook idempotency: true only the first time an event id is seen. */
  markEventProcessed(eventId: string): boolean {
    if (this.processedEventIds.has(eventId)) return false;
    this.processedEventIds.add(eventId);
    return true;
  }

  hasProcessedEvent(eventId: string): boolean {
    return this.processedEventIds.has(eventId);
  }

  private mustGet(planId: string): ActionPlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Unknown plan: ${planId}`);
    return plan;
  }
}
