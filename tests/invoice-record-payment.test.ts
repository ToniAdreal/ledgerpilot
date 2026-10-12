import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import { PayPalError, type PayPalClient } from "../src/lib/paypal/client";
import { LedgerStore } from "../src/lib/agent/store";
import { parseBrief } from "../src/lib/agent/parser";
import { executePlan } from "../src/lib/agent/executor";
import { buildInvoiceRows, computeSummary } from "../src/lib/console/read-models";
import { InvoicePaymentError, recordInvoicePayment } from "../src/lib/invoice";
import { seedJudgeScenario } from "../src/lib/judge";
import type { Invoice } from "../src/lib/types";

function freshRuntime() {
  return { client: new MockPayPalClient(), store: new LedgerStore() };
}

const SPINE =
  "Invoice Ana $450 for brand work, due Friday. When it lands, pay $200 to my contractor Marco.";

/** Execute an approved brief; returns the created invoice's id. */
async function executedInvoice(
  client: MockPayPalClient,
  store: LedgerStore,
  brief = SPINE,
): Promise<string> {
  const plan = store.addPlan(parseBrief(brief, { now: new Date("2026-10-10T12:00:00Z") }));
  store.approvePlan(plan.id);
  await executePlan(store, client, plan.id);
  const invoices = await client.listInvoices();
  return invoices[invoices.length - 1]!.id;
}

describe("invoice record-payment leg — any open invoice can be marked paid in-app", () => {
  it("the full loop: a spine invoice recorded paid flips to PAID and resumes its gated payout exactly once", async () => {
    const { client, store } = freshRuntime();
    const invoiceId = await executedInvoice(client, store);
    const plan = store.listPlans()[0]!;
    expect(plan.status).toBe("awaiting_trigger");

    const result = await recordInvoicePayment(client, store, invoiceId);
    expect(result.alreadyPaid).toBe(false);
    expect(result.invoice).toMatchObject({
      id: invoiceId,
      status: "PAID",
      recordedAmount: "450.00",
      dueAmount: "0.00",
      currency_code: "USD",
    });
    expect(result.sync).not.toBeNull();
    // The reconciler processes the invoice-PAID event and then the
    // resumed payout's own SUCCEEDED event in the same drain.
    expect(result.sync!.processedEventIds).toHaveLength(2);
    expect(result.sync!.resumed.map((r) => r.plan.id)).toEqual([plan.id]);
    expect(store.getPlan(plan.id)?.status).toBe("completed");

    const payouts = await client.listPayouts();
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.items[0]).toMatchObject({ transaction_status: "SUCCESS" });
    const txns = await client.listTransactions();
    expect(txns.map((t) => t.transaction_amount.value).sort()).toEqual(["-200.00", "450.00"]);

    const rows = buildInvoiceRows(await client.listInvoices(), "2026-10-10");
    expect(rows.find((r) => r.id === invoiceId)).toMatchObject({ status: "PAID" });
    const summary = computeSummary({
      invoices: await client.listInvoices(),
      orders: [],
      payouts,
      disputes: [],
      transactions: txns,
      plans: store.listPlans(),
      activity: store.listActivity(),
      referenceDate: "2026-10-10",
    });
    expect(summary.collected).toEqual([{ currency_code: "USD", value: "450.00" }]);

    const callRow = store
      .listActivity()
      .find((a) => a.kind === "paypal_call" && a.summary.includes("/payments"));
    expect(callRow?.summary).toContain(`POST /v2/invoicing/invoices/${invoiceId}/payments`);
    expect(callRow?.detail).toMatchObject({ invoiceId, recorded: true });
  });

  it("a partial payment flips to PARTIALLY_PAID with no event, no transaction, and no resumed payout — the remainder then closes it", async () => {
    const { client, store } = freshRuntime();
    const invoiceId = await executedInvoice(client, store);

    const partial = await recordInvoicePayment(client, store, invoiceId, { amount: "150" });
    expect(partial.invoice).toMatchObject({
      status: "PARTIALLY_PAID",
      recordedAmount: "150.00",
      dueAmount: "300.00",
    });
    expect(partial.sync?.processedEventIds).toEqual([]);
    expect(await client.listTransactions()).toHaveLength(0);
    expect(await client.listPayouts()).toHaveLength(0);
    expect(store.listPlans()[0]!.status).toBe("awaiting_trigger");

    const rest = await recordInvoicePayment(client, store, invoiceId);
    expect(rest.invoice.status).toBe("PAID");
    expect(rest.invoice.recordedAmount).toBe("300.00");
    expect(store.listPlans()[0]!.status).toBe("completed");
    expect(await client.listPayouts()).toHaveLength(1);
  });

  it("a Judge Mode seeded open invoice (not the spine) can be recorded paid through the same path", async () => {
    const { client, store } = freshRuntime();
    await seedJudgeScenario(client, store);
    const sam = (await client.listInvoices()).find((i) => i.status === "SENT" && i.amount.value === "280.00")!;
    const result = await recordInvoicePayment(client, store, sam.id);
    expect(result.invoice.status).toBe("PAID");
    // The spine plan was never executed, so nothing resumed.
    expect(result.sync?.resumed).toEqual([]);
    expect(store.listPlans()[0]!.status).toBe("pending_approval");
  });

  it("recording an already-PAID invoice is an alreadyPaid no-op — no second call, transaction, or audit row", async () => {
    const { client, store } = freshRuntime();
    const invoiceId = await executedInvoice(client, store);
    await recordInvoicePayment(client, store, invoiceId);
    const callsBefore = store.listActivity().filter((a) => a.kind === "paypal_call").length;
    const txnsBefore = (await client.listTransactions()).length;

    const again = await recordInvoicePayment(client, store, invoiceId);
    expect(again.alreadyPaid).toBe(true);
    expect(again.sync).toBeNull();
    expect(store.listActivity().filter((a) => a.kind === "paypal_call")).toHaveLength(callsBefore);
    expect(await client.listTransactions()).toHaveLength(txnsBefore);
  });

  it("unknown ids 404 and a DRAFT invoice 409s — nothing is recorded either way", async () => {
    const { client, store } = freshRuntime();
    await expect(recordInvoicePayment(client, store, "INV2-999999")).rejects.toMatchObject({
      name: "InvoicePaymentError",
      status: 404,
    } satisfies Partial<InvoicePaymentError>);

    const draft = await client.createInvoice({
      recipient: { name: "Ana", email_address: "ana@example.com" },
      items: [{ name: "Logo work", quantity: "1", unit_amount: { value: "10.00", currency_code: "USD" } }],
    });
    await expect(recordInvoicePayment(client, store, draft.id)).rejects.toMatchObject({
      name: "InvoicePaymentError",
      status: 409,
    });
    expect((await client.getInvoice(draft.id)).status).toBe("DRAFT");
  });

  it("invalid amounts are refused before any adapter call: zero, non-numeric, over-due, wrong currency", async () => {
    const { client, store } = freshRuntime();
    const invoiceId = await executedInvoice(client, store, "Invoice Ana $450 for brand work, due Friday");
    for (const input of [
      { amount: "0" },
      { amount: "-5" },
      { amount: "abc" },
      { amount: "450.01" },
      { amount: "10", currency_code: "EUR" },
    ]) {
      await expect(recordInvoicePayment(client, store, invoiceId, input)).rejects.toMatchObject({
        name: "InvoicePaymentError",
        status: 422,
      });
    }
    const invoice = await client.getInvoice(invoiceId);
    expect(invoice.status).toBe("SENT");
    expect(invoice.due_amount.value).toBe("450.00");
    expect(await client.listTransactions()).toHaveLength(0);
  });

  it("an adapter refusal propagates with PayPal's status and is audit-logged as a failure, never a success", async () => {
    const { client, store } = freshRuntime();
    const invoiceId = await executedInvoice(client, store, "Invoice Ana $450 for brand work, due Friday");
    const refusing = {
      ...client,
      mode: client.mode,
      listInvoices: () => client.listInvoices(),
      recordInvoicePayment: async (): Promise<Invoice> => {
        throw new PayPalError("Invoice cannot be paid in its current state", 422, "UNPROCESSABLE_ENTITY");
      },
    } as unknown as PayPalClient;

    await expect(recordInvoicePayment(refusing, store, invoiceId)).rejects.toMatchObject({
      name: "PayPalError",
      status: 422,
    });
    const failure = store.listActivity().find((a) => a.summary.includes("failed"));
    expect(failure?.kind).toBe("system");
    expect(failure?.detail).toMatchObject({ invoiceId, recorded: false });
    expect(store.listActivity().some((a) => a.summary.includes("/payments →"))).toBe(false);
  });
});
