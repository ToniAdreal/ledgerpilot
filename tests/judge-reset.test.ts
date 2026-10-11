import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LedgerStore } from "../src/lib/agent/store";
import { executePlan } from "../src/lib/agent/executor";
import type { CreateInvoiceInput } from "../src/lib/types";
import type { PayPalClient } from "../src/lib/paypal/client";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import {
  JudgeModeError,
  getJudgeState,
  isJudgeSeeded,
  resetJudgeDemo,
  seedJudgeScenario,
  simulateJudgeInvoicePayment,
} from "../src/lib/judge";

function freshRuntime() {
  return { client: new MockPayPalClient(), store: new LedgerStore() };
}

async function runFullLoop(client: MockPayPalClient, store: LedgerStore): Promise<string> {
  const { seed } = await seedJudgeScenario(client, store);
  store.approvePlan(seed.spinePlanId);
  await executePlan(store, client, seed.spinePlanId);
  const payment = await simulateJudgeInvoicePayment(client, store);
  expect(payment.spinePlanStatus).toBe("completed");
  return seed.spinePlanId;
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ledgerpilot-reset-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("ledger store reset", () => {
  it("clears plans, activity, and processed events and reports the counts", async () => {
    const { client, store } = freshRuntime();
    await seedJudgeScenario(client, store);
    const activityBefore = store.listActivity().length;
    expect(activityBefore).toBeGreaterThan(0);

    const cleared = store.reset();
    expect(cleared.plans).toBe(1);
    expect(cleared.activity).toBe(activityBefore);
    expect(cleared.processedEvents).toBe(3); // the seed's historical events
    expect(store.listPlans()).toEqual([]);
    expect(store.listActivity()).toEqual([]);
    expect(isJudgeSeeded(store)).toBe(false);
  });

  it("never reuses an activity id after a reset", async () => {
    const store = new LedgerStore();
    const first = store.record({ kind: "system", summary: "before reset" });
    store.reset();
    const second = store.record({ kind: "system", summary: "after reset" });
    expect(second.id).not.toBe(first.id);
    expect(Number(second.id.replace("act-", ""))).toBeGreaterThan(
      Number(first.id.replace("act-", "")),
    );
  });
});

describe("mock adapter reset", () => {
  it("clears every resource and restores the flagged sample dispute", async () => {
    const { client, store } = freshRuntime();
    await runFullLoop(client, store);
    expect((await client.listDisputes())[0]?.sample).toBe(true);

    const cleared = client.reset();
    expect(cleared.invoices).toBe(4); // 3 seeded history + the spine invoice
    expect(cleared.orders).toBe(1);
    expect(cleared.payouts).toBe(2); // seeded history + the gated spine payout
    expect(cleared.transactions).toBeGreaterThanOrEqual(4);
    expect(cleared.emittedEvents).toBeGreaterThanOrEqual(4);

    expect(await client.listInvoices()).toEqual([]);
    expect(await client.listOrders()).toEqual([]);
    expect(await client.listPayouts()).toEqual([]);
    expect(await client.listTransactions()).toEqual([]);
    expect(client.emittedEvents).toEqual([]);
    const disputes = await client.listDisputes();
    expect(disputes).toHaveLength(1);
    expect(disputes[0]?.dispute_id).toBe("PP-D-SAMPLE-001");
    expect(disputes[0]?.sample).toBe(true);
  });

  it("honours a sampleDispute: false client — reset restores no dispute", async () => {
    const client = new MockPayPalClient({ sampleDispute: false });
    expect(await client.listDisputes()).toEqual([]);
    await client.createInvoice({
      recipient: { name: "Ana", email_address: "ana@example.com" },
      items: [{ name: "Icon set", quantity: "1", unit_amount: { currency_code: "USD", value: "10.00" } }],
    });
    client.reset();
    expect(await client.listInvoices()).toEqual([]);
    expect(await client.listDisputes()).toEqual([]);
  });

  it("never reuses a resource id after a reset", async () => {
    const client = new MockPayPalClient();
    const input: CreateInvoiceInput = {
      recipient: { name: "Ana", email_address: "ana@example.com" },
      items: [{ name: "Icon set", quantity: "1", unit_amount: { currency_code: "USD", value: "10.00" } }],
    };
    const before = await client.createInvoice(input);
    client.reset();
    const after = await client.createInvoice(input);
    expect(after.id).not.toBe(before.id);
  });
});

describe("resetJudgeDemo — the multi-judge path", () => {
  it("on a fresh runtime clears nothing and leaves an unseeded state", async () => {
    const { client, store } = freshRuntime();
    const result = await resetJudgeDemo(client, store);
    expect(result.cleared.plans).toBe(0);
    expect(result.cleared.invoices).toBe(0);
    expect(result.state.seeded).toBe(false);
    expect(result.state.counts).toEqual({ invoices: 0, orders: 0, payouts: 0, plans: 0 });
  });

  it("after a completed loop, resets to a clean slate and the full loop closes a second time", async () => {
    const { client, store } = freshRuntime();
    const firstPlanId = await runFullLoop(client, store);

    const result = await resetJudgeDemo(client, store);
    expect(result.cleared.plans).toBe(1);
    expect(result.cleared.invoices).toBe(4);
    expect(result.cleared.payouts).toBe(2);
    expect(result.state.seeded).toBe(false);
    expect(result.state.spinePlan).toBeNull();
    expect(result.state.counts).toEqual({ invoices: 0, orders: 0, payouts: 0, plans: 0 });
    expect(store.listActivity()).toEqual([]);
    expect(await client.listTransactions()).toEqual([]);

    // Second run from the top: seeding is fresh (not alreadySeeded),
    // the new spine plan is a different plan, and the loop closes again.
    const secondPlanId = await runFullLoop(client, store);
    expect(secondPlanId).not.toBe(firstPlanId);
    const state = await getJudgeState(store, client);
    expect(state.spinePlan?.status).toBe("completed");
    const amounts = (await client.listTransactions()).map((t) => t.transaction_amount.value);
    expect(amounts).toContain("450.00");
    expect(amounts).toContain("-200.00");
  });

  it("refuses in sandbox mode and touches nothing", async () => {
    const { client, store } = freshRuntime();
    const { seed } = await seedJudgeScenario(client, store);
    const sandboxStub = { mode: "sandbox" } as unknown as PayPalClient;

    await expect(resetJudgeDemo(sandboxStub, store)).rejects.toBeInstanceOf(JudgeModeError);
    await expect(resetJudgeDemo(sandboxStub, store)).rejects.toThrow(/mock mode only/);
    // The refusal happens before any mutation: the seeded demo survives.
    expect(isJudgeSeeded(store)).toBe(true);
    expect(store.getPlan(seed.spinePlanId)?.status).toBe("pending_approval");
    expect(await client.listInvoices()).toHaveLength(3);
  });

  it("refuses a mock-mode adapter without a reset capability", async () => {
    const store = new LedgerStore();
    const noReset = { mode: "mock" } as unknown as PayPalClient;
    await expect(resetJudgeDemo(noReset, store)).rejects.toThrow(/does not support demo reset/);
  });

  it("persists the emptied snapshots — reopened file-backed instances start fresh", async () => {
    const dir = tempDir();
    const ledgerFile = join(dir, "ledger.ledger.json");
    const mockFile = join(dir, "mock.mock-paypal.json");
    const client = new MockPayPalClient({ filePath: mockFile });
    const store = new LedgerStore({ filePath: ledgerFile });
    await seedJudgeScenario(client, store);

    await resetJudgeDemo(client, store);

    const reopenedClient = new MockPayPalClient({ filePath: mockFile });
    const reopenedStore = new LedgerStore({ filePath: ledgerFile });
    expect(await reopenedClient.listInvoices()).toEqual([]);
    expect(await reopenedClient.listTransactions()).toEqual([]);
    // The sample dispute lives inside the snapshot: restored once, not duplicated.
    expect(await reopenedClient.listDisputes()).toHaveLength(1);
    expect(reopenedStore.listPlans()).toEqual([]);
    expect(reopenedStore.listActivity()).toEqual([]);
    expect(isJudgeSeeded(reopenedStore)).toBe(false);
  });
});
