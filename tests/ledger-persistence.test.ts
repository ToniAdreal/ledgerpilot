import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LEDGER_STORE_FILE_ENV,
  LEDGER_STORE_SNAPSHOT_VERSION,
  LedgerStore,
  LedgerStorePersistenceError,
  executePlan,
  ledgerStoreFromEnv,
  parseBrief,
} from "@/lib/agent";
import { MockPayPalClient } from "@/lib/paypal";

// Saturday, Oct 10 2026 (UTC) — the demo-spine reference date.
const NOW = new Date("2026-10-10T12:00:00Z");
const DEMO_BRIEF =
  "Invoice Ana $450 for brand work, due Friday. When it lands, pay $200 to my contractor Marco.";

const dirs: string[] = [];
function tempStoreFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "ledgerpilot-store-"));
  dirs.push(dir);
  return join(dir, "nested", "ledger.ledger.json");
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("ledger store persistence (opt-in file snapshot)", () => {
  it("is in-memory by default and via a blank env var — no file is created", () => {
    expect(new LedgerStore().persistenceFile).toBeUndefined();
    const fromEnv = ledgerStoreFromEnv({});
    expect(fromEnv.persistenceFile).toBeUndefined();
    const blank = ledgerStoreFromEnv({ [LEDGER_STORE_FILE_ENV]: "   " });
    expect(blank.persistenceFile).toBeUndefined();
  });

  it("ledgerStoreFromEnv returns a file-backed store when the env var is set", () => {
    const file = tempStoreFile();
    const store = ledgerStoreFromEnv({ [LEDGER_STORE_FILE_ENV]: file });
    expect(store.persistenceFile).toBe(file);
    store.addPlan(parseBrief("Pay Marco $75", { now: NOW, planId: "plan-env-1" }));
    expect(existsSync(file)).toBe(true);
  });

  it("restores plans, activity, and webhook idempotency after a restart — audit ids never repeat", async () => {
    const file = tempStoreFile();
    const client = new MockPayPalClient();
    const first = new LedgerStore({ filePath: file });
    const plan = first.addPlan(parseBrief(DEMO_BRIEF, { now: NOW, planId: "plan-persist-1" }));
    first.approvePlan(plan.id);
    const executed = await executePlan(first, client, plan.id);
    expect(executed.plan.status).toBe("awaiting_trigger"); // replacePlanSteps bound the gated step
    expect(first.markEventProcessed("WH-PERSIST-1")).toBe(true);
    const activityBefore = first.listActivity();
    const maxIdBefore = Math.max(...activityBefore.map((a) => Number(a.id.replace("act-", ""))));

    // Restart: a brand-new store over the same file.
    const reopened = new LedgerStore({ filePath: file });
    const restored = reopened.getPlan(plan.id);
    expect(restored?.status).toBe("awaiting_trigger");
    // The trigger binding written at execution time survived the restart.
    expect(restored?.steps[1]?.trigger?.resourceId).toBe(executed.outcomes[0]?.resultId);
    expect(reopened.listActivity().map((a) => a.summary)).toEqual(activityBefore.map((a) => a.summary));
    // Idempotency survived: the same webhook can never be processed twice.
    expect(reopened.hasProcessedEvent("WH-PERSIST-1")).toBe(true);
    expect(reopened.markEventProcessed("WH-PERSIST-1")).toBe(false);
    // New audit records continue the sequence instead of colliding.
    const next = reopened.record({ kind: "system", summary: "after restart" });
    expect(Number(next.id.replace("act-", ""))).toBeGreaterThan(maxIdBefore);
    const allIds = reopened.listActivity().map((a) => a.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("persists a bare status update (no activity record) too", () => {
    const file = tempStoreFile();
    const store = new LedgerStore({ filePath: file });
    const plan = store.addPlan(parseBrief("Pay Marco $75", { now: NOW, planId: "plan-status-1" }));
    store.updatePlanStatus(plan.id, "executing");
    expect(new LedgerStore({ filePath: file }).getPlan(plan.id)?.status).toBe("executing");
  });

  it("writes a versioned, valid-JSON snapshot atomically (no temp file left behind)", () => {
    const file = tempStoreFile();
    const store = new LedgerStore({ filePath: file });
    store.addPlan(parseBrief("Pay Marco $75", { now: NOW, planId: "plan-snap-1" }));
    const snap = JSON.parse(readFileSync(file, "utf8")) as {
      version: number;
      plans: unknown[];
      activity: unknown[];
      processedEventIds: unknown[];
    };
    expect(snap.version).toBe(LEDGER_STORE_SNAPSHOT_VERSION);
    expect(snap.plans).toHaveLength(1);
    expect(snap.activity.length).toBeGreaterThan(0);
    expect(snap.processedEventIds).toEqual([]);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it("refuses a corrupt snapshot loudly and leaves the file untouched", () => {
    const file = tempStoreFile();
    const store = new LedgerStore({ filePath: file });
    store.addPlan(parseBrief("Pay Marco $75", { now: NOW, planId: "plan-corrupt-1" }));
    writeFileSync(file, "{ not json", "utf8");
    expect(() => new LedgerStore({ filePath: file })).toThrow(LedgerStorePersistenceError);
    expect(() => new LedgerStore({ filePath: file })).toThrow(/corrupt audit log/);
    expect(readFileSync(file, "utf8")).toBe("{ not json"); // never silently overwritten
  });

  it("refuses an unsupported snapshot version", () => {
    const file = tempStoreFile();
    // Create the parent directory + file through a first store, then downgrade the version.
    const store = new LedgerStore({ filePath: file });
    store.addPlan(parseBrief("Pay Marco $75", { now: NOW, planId: "plan-ver-1" }));
    const snap = JSON.parse(readFileSync(file, "utf8")) as { version: number };
    snap.version = 999;
    writeFileSync(file, JSON.stringify(snap), "utf8");
    expect(() => new LedgerStore({ filePath: file })).toThrow(/unsupported or malformed snapshot/);
  });
});
