import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LedgerStore } from "../src/lib/agent/store";
import { API_OPERATIONS } from "../src/lib/api";
import type { PayPalClient } from "../src/lib/paypal/client";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { JudgeModeError, isJudgeSeeded, seedJudgeScenario } from "../src/lib/judge";

/**
 * Judge Mode seeding is mock-only (parity with the demo reset, which
 * has refused in sandbox mode since it landed): the seeded history
 * only exists in the mock — a captured order with no buyer, a flagged
 * sample dispute — and in sandbox mode the same calls would create
 * real sandbox resources at PayPal for fictional recipients, then
 * strand them half-written when the order capture is refused. The
 * guard must therefore run before anything is read or written.
 */

const ADAPTER_METHODS = [
  "createInvoice",
  "sendInvoice",
  "getInvoice",
  "listInvoices",
  "recordInvoicePayment",
  "sendInvoiceReminder",
  "createOrder",
  "captureOrder",
  "listOrders",
  "createPayout",
  "listPayouts",
  "listDisputes",
  "listTransactions",
  "verifyWebhookSignature",
] as const;

function sandboxStub() {
  const calls: string[] = [];
  const stub: Record<string, unknown> = { mode: "sandbox" };
  for (const name of ADAPTER_METHODS) {
    stub[name] = vi.fn(async () => {
      calls.push(name);
      throw new Error(`sandbox stub: ${name} must never be called by seeding`);
    });
  }
  return { client: stub as unknown as PayPalClient, calls };
}

describe("judge seed sandbox guard", () => {
  it("refuses in sandbox mode before touching anything", async () => {
    const { client, calls } = sandboxStub();
    const store = new LedgerStore();

    const err = await seedJudgeScenario(client, store).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JudgeModeError);
    expect((err as Error).message).toMatch(/mock mode only/);
    // The refusal names the actual consequence, not a bare mode check:
    // the history would be created at PayPal for fictional recipients.
    expect((err as Error).message).toMatch(/created at PayPal for fictional recipients/);
    expect((err as Error).message).toMatch(/PAYPAL_MODE=mock/);

    expect(calls).toEqual([]);
    expect(store.listPlans()).toEqual([]);
    expect(store.listActivity()).toEqual([]);
    expect(isJudgeSeeded(store)).toBe(false);
  });

  it("refuses ahead of the already-seeded answer, leaving a seeded store untouched", async () => {
    const store = new LedgerStore();
    const mock = new MockPayPalClient();
    const seeded = await seedJudgeScenario(mock, store);
    expect(seeded.alreadySeeded).toBe(false);
    const plansBefore = store.listPlans().length;
    const activityBefore = store.listActivity().length;

    const { client, calls } = sandboxStub();
    await expect(seedJudgeScenario(client, store)).rejects.toThrow(/mock mode only/);
    expect(calls).toEqual([]);
    expect(store.listPlans()).toHaveLength(plansBefore);
    expect(store.listActivity()).toHaveLength(activityBefore);
    expect(isJudgeSeeded(store)).toBe(true);
  });

  it("mock mode still seeds, and a second seed is the idempotent no-op", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    const first = await seedJudgeScenario(client, store);
    expect(first.alreadySeeded).toBe(false);
    const second = await seedJudgeScenario(client, store);
    expect(second.alreadySeeded).toBe(true);
    expect(second.seed.spinePlanId).toBe(first.seed.spinePlanId);
    expect(await client.listInvoices()).toHaveLength(3);
  });

  it("the seed route maps the refusal to a 409, like the pay and reset routes", () => {
    const seedRoute = readFileSync(
      join(process.cwd(), "src/app/api/judge/seed/route.ts"),
      "utf8",
    );
    expect(seedRoute).toContain("err instanceof JudgeModeError");
    expect(seedRoute).toContain("status: 409");
  });

  it("the OpenAPI registry declares the seed operation's 409 refusal", () => {
    const op = API_OPERATIONS.find((o) => o.operationId === "seedJudgeScenario");
    expect(op).toBeDefined();
    expect(op!.responses["409"]).toMatch(/sandbox mode/);
    expect(op!.description).toMatch(/Mock mode only/);
    expect(op!.description).toMatch(/before touching anything/);
  });

  it("the README documents the seed's mock-only refusal next to the reset's", () => {
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
    expect(readme).toContain("Seeding is mock-mode only");
  });
});
