import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LedgerStore } from "../src/lib/agent/store";
import { executePlan } from "../src/lib/agent/executor";
import { API_OPERATIONS } from "../src/lib/api";
import type { PayPalClient } from "../src/lib/paypal/client";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import {
  JudgeModeError,
  isJudgeSeeded,
  seedJudgeScenario,
  simulateJudgeInvoicePayment,
} from "../src/lib/judge";

/**
 * Judge Mode payment simulation is mock-only (parity with the seed
 * and reset guards): the spine invoice it pays only exists in the
 * mock — it is created by executing the seeded spine plan, and
 * seeding itself is mock-only — so in sandbox mode there is no
 * legitimate spine invoice to pay, and a simulated record-payment
 * is not how a sandbox invoice gets paid in any case. The guard
 * must therefore run before anything is read or written.
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
      throw new Error(`sandbox stub: ${name} must never be called by payment simulation`);
    });
  }
  return { client: stub as unknown as PayPalClient, calls };
}

describe("judge pay sandbox guard", () => {
  it("refuses in sandbox mode before touching anything", async () => {
    const { client, calls } = sandboxStub();
    const store = new LedgerStore();

    const err = await simulateJudgeInvoicePayment(client, store).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JudgeModeError);
    expect((err as Error).message).toMatch(/mock mode only/);
    // The refusal names the actual reason, not a bare mode check:
    // the spine invoice only exists in the mock.
    expect((err as Error).message).toMatch(/spine invoice only exists in the mock/);
    expect((err as Error).message).toMatch(/PAYPAL_MODE=mock/);

    expect(calls).toEqual([]);
    expect(store.listPlans()).toEqual([]);
    expect(store.listActivity()).toEqual([]);
    expect(isJudgeSeeded(store)).toBe(false);
  });

  it("refuses ahead of the seeded/executed checks, leaving a seeded store untouched", async () => {
    const store = new LedgerStore();
    const mock = new MockPayPalClient();
    const seeded = await seedJudgeScenario(mock, store);
    store.approvePlan(seeded.seed.spinePlanId);
    await executePlan(store, mock, seeded.seed.spinePlanId);
    const plansBefore = store.listPlans().length;
    const activityBefore = store.listActivity().length;

    const { client, calls } = sandboxStub();
    await expect(simulateJudgeInvoicePayment(client, store)).rejects.toThrow(/mock mode only/);
    expect(calls).toEqual([]);
    expect(store.listPlans()).toHaveLength(plansBefore);
    expect(store.listActivity()).toHaveLength(activityBefore);
    expect(isJudgeSeeded(store)).toBe(true);
    // The mock spine invoice is still unpaid — nothing was recorded.
    const invoices = await mock.listInvoices();
    const spine = invoices[invoices.length - 1];
    expect(spine?.status).toBe("SENT");
  });

  it("mock mode still pays, closes the loop, and a repeat is the alreadyPaid no-op", async () => {
    const client = new MockPayPalClient();
    const store = new LedgerStore();
    const seeded = await seedJudgeScenario(client, store);
    store.approvePlan(seeded.seed.spinePlanId);
    await executePlan(store, client, seeded.seed.spinePlanId);

    const payment = await simulateJudgeInvoicePayment(client, store);
    expect(payment.alreadyPaid).toBe(false);
    expect(payment.invoice.status).toBe("PAID");
    expect(payment.spinePlanStatus).toBe("completed");

    const again = await simulateJudgeInvoicePayment(client, store);
    expect(again.alreadyPaid).toBe(true);
  });

  it("the pay route maps the refusal to a 409, like the seed and reset routes", () => {
    const payRoute = readFileSync(
      join(process.cwd(), "src/app/api/judge/pay/route.ts"),
      "utf8",
    );
    expect(payRoute).toContain("err instanceof JudgeModeError");
    expect(payRoute).toContain("status: 409");
  });

  it("the OpenAPI registry declares the pay operation's 409 sandbox refusal", () => {
    const op = API_OPERATIONS.find((o) => o.operationId === "simulateJudgePayment");
    expect(op).toBeDefined();
    expect(op!.responses["409"]).toMatch(/sandbox mode/);
    expect(op!.description).toMatch(/Mock mode only/);
    expect(op!.description).toMatch(/before touching anything/);
  });

  it("the README documents the payment simulation's mock-only refusal next to the seed's", () => {
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
    expect(readme).toContain("Payment simulation is mock-mode only");
  });
});
