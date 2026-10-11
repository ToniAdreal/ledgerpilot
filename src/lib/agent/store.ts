/**
 * Ledger store — plans, the append-only activity (audit) log, and the
 * set of webhook event ids already processed.
 *
 * The store's *semantics* are the product invariant: every plan,
 * approval, PayPal call, and webhook lands in the activity log, and a
 * webhook event id is processed at most once.
 *
 * Persistence (opt-in): by default the store is in-memory, exactly as
 * the October mock-first scope ran. When a file path is supplied
 * (constructor option, or the `LEDGERPILOT_STORE_FILE` env var through
 * `ledgerStoreFromEnv` / the API runtime), every mutation is written
 * through to that file as a versioned JSON snapshot — written to a
 * sibling temp file and renamed over the target, so a crash mid-write
 * never leaves a torn snapshot. A second store opened on the same file
 * restores plans, activity, processed event ids, and the activity
 * sequence, so audit ids never repeat after a restart.
 *
 * Design call, recorded: CONCEPT.md §3.1 sketched "SQLite (via Prisma
 * or Drizzle)". This snapshot store deliberately adds no dependency —
 * Prisma/Drizzle would break the zero-setup fresh-clone judge run —
 * while covering the single-process hosted demo the persistence is
 * for. It is NOT a multi-writer database: run one server process per
 * store file. A corrupt or unsupported snapshot fails loudly
 * (`LedgerStorePersistenceError`) instead of silently discarding the
 * audit log. PayPal resources are not stored here — in sandbox mode
 * they live at PayPal and are re-fetched; in mock mode the adapter has
 * its own opt-in snapshot (`PAYPAL_MOCK_STORE_FILE`, see mock.ts), and
 * setting both files makes a mock-mode restart lose nothing.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ActionPlan, ActivityRecord } from "../types";

let actSeq = 0;

export const LEDGER_STORE_SNAPSHOT_VERSION = 1;

/** Env var that turns on file persistence for the API runtime. */
export const LEDGER_STORE_FILE_ENV = "LEDGERPILOT_STORE_FILE";

export class LedgerStorePersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerStorePersistenceError";
  }
}

export interface LedgerStoreOptions {
  /**
   * Path of the JSON snapshot file. When set, the store loads any
   * existing snapshot from it and writes every mutation through.
   * When unset, the store is purely in-memory.
   */
  filePath?: string;
}

interface LedgerSnapshot {
  version: number;
  actSeq: number;
  plans: ActionPlan[];
  activity: ActivityRecord[];
  processedEventIds: string[];
}

export class LedgerStore {
  private plans = new Map<string, ActionPlan>();
  private activity: ActivityRecord[] = [];
  private processedEventIds = new Set<string>();
  private readonly filePath?: string;

  constructor(options: LedgerStoreOptions = {}) {
    this.filePath = options.filePath;
    if (this.filePath) this.load();
  }

  /** The snapshot file this store persists to, when persistence is on. */
  get persistenceFile(): string | undefined {
    return this.filePath;
  }

  private load(): void {
    const path = this.filePath!;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      // A missing file is the normal first run — anything else (permissions,
      // a directory in the way) must not be mistaken for an empty ledger.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new LedgerStorePersistenceError(
        `Cannot read ledger store file ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new LedgerStorePersistenceError(
        `Ledger store file ${path} is not valid JSON — refusing to start from a corrupt audit log. Fix or remove the file to start fresh.`,
      );
    }
    const snap = parsed as Partial<LedgerSnapshot> | null;
    if (
      !snap ||
      typeof snap !== "object" ||
      snap.version !== LEDGER_STORE_SNAPSHOT_VERSION ||
      !Array.isArray(snap.plans) ||
      !Array.isArray(snap.activity) ||
      !Array.isArray(snap.processedEventIds)
    ) {
      throw new LedgerStorePersistenceError(
        `Ledger store file ${path} has an unsupported or malformed snapshot (expected version ${LEDGER_STORE_SNAPSHOT_VERSION}) — refusing to discard it silently.`,
      );
    }
    for (const plan of snap.plans) this.plans.set(plan.id, structuredClone(plan));
    this.activity = snap.activity.map((r) => structuredClone(r));
    this.processedEventIds = new Set(snap.processedEventIds);
    // Activity ids must never repeat: continue past both the snapshot's
    // own sequence and any ids already issued in this process.
    const maxRecorded = this.activity.reduce((max, r) => {
      const n = Number.parseInt(r.id.replace(/^act-/, ""), 10);
      return Number.isFinite(n) ? Math.max(max, n) : max;
    }, 0);
    actSeq = Math.max(actSeq, snap.actSeq ?? 0, maxRecorded);
  }

  private persist(): void {
    if (!this.filePath) return;
    const snapshot: LedgerSnapshot = {
      version: LEDGER_STORE_SNAPSHOT_VERSION,
      actSeq,
      plans: [...this.plans.values()].map((p) => structuredClone(p)),
      activity: this.activity.map((r) => structuredClone(r)),
      processedEventIds: [...this.processedEventIds],
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    renameSync(tmp, this.filePath);
  }

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
    this.persist();
    return structuredClone(plan);
  }

  replacePlanSteps(planId: string, steps: ActionPlan["steps"]): ActionPlan {
    const plan = this.mustGet(planId);
    plan.steps = structuredClone(steps);
    this.persist();
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
    this.persist();
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
    this.persist();
    return true;
  }

  hasProcessedEvent(eventId: string): boolean {
    return this.processedEventIds.has(eventId);
  }

  /**
   * Clear every plan, activity record, and processed event id, and
   * persist the emptied snapshot when persistence is on. This is the
   * ledger half of the Judge Mode demo reset (see judge-mode.ts): a
   * hosted demo instance returns to a fresh slate so the next judge
   * can seed and run the scenario from the top. The activity sequence
   * (`actSeq`) deliberately does NOT rewind — audit ids are never
   * reused, even across a reset. Returns what was cleared.
   */
  reset(): { plans: number; activity: number; processedEvents: number } {
    const cleared = {
      plans: this.plans.size,
      activity: this.activity.length,
      processedEvents: this.processedEventIds.size,
    };
    this.plans.clear();
    this.activity = [];
    this.processedEventIds.clear();
    this.persist();
    return cleared;
  }

  private mustGet(planId: string): ActionPlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Unknown plan: ${planId}`);
    return plan;
  }
}

/**
 * Build a store from an env-shaped record: `LEDGERPILOT_STORE_FILE`
 * set (non-blank) → file-backed store at that path; unset → the
 * default in-memory store. Used by the API runtime so the hosted
 * deployment can persist the ledger without any code change.
 */
export function ledgerStoreFromEnv(env: Record<string, string | undefined> = process.env): LedgerStore {
  const filePath = env[LEDGER_STORE_FILE_ENV]?.trim();
  return filePath ? new LedgerStore({ filePath }) : new LedgerStore();
}
