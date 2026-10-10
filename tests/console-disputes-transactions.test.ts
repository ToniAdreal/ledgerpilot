import { describe, expect, it } from "vitest";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import {
  buildDisputeRows,
  buildTransactionRows,
  computeSummary,
} from "../src/lib/console/read-models";
import { resolveGridOverlay } from "../src/lib/console/states";
import type { Dispute } from "../src/lib/types";

const ANA = { name: "Ana", email_address: "ana@example.com" };
const MARCO = { name: "Marco", email_address: "marco@example.com" };

function disputeFixture(overrides: Partial<Dispute> = {}): Dispute {
  return {
    dispute_id: "PP-D-TEST-1",
    create_time: "2026-10-05T09:00:00Z",
    update_time: "2026-10-06T09:00:00Z",
    disputed_transactions: [
      { seller_transaction_id: "TXN-TEST-1", buyer: { name: "Sam Rivera", email_address: "sam@example.com" } },
    ],
    amount: { currency_code: "USD", value: "120.00" },
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    status: "WAITING_FOR_SELLER_RESPONSE",
    dispute_life_cycle_stage: "INQUIRY",
    response_due_date: "2026-10-09T23:59:59Z",
    ...overrides,
  };
}

describe("console dispute rows (read-only)", () => {
  it("projects the mock sample dispute with its sample flag and deadline", async () => {
    const client = new MockPayPalClient({ sampleDispute: true });
    const rows = buildDisputeRows(await client.listDisputes(), "2026-10-10");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe("PP-D-SAMPLE-001");
    expect(row.sample).toBe(true);
    expect(row.buyerName).toBe("Sam Rivera");
    expect(row.sellerTransactionId).toBe("TXN-SAMPLE-001");
    expect(row.status).toBe("WAITING_FOR_SELLER_RESPONSE");
    expect(row.amountValue).toBe(120);
    expect(row.responseDueDate).toBe("2026-10-29T23:59:59Z");
    // Deadline (Oct 29) is after the reference date (Oct 10): not overdue.
    expect(row.responseOverdue).toBe(false);
  });

  it("flags an open dispute past its response deadline, never a resolved one", () => {
    const open = buildDisputeRows([disputeFixture()], "2026-10-10")[0]!;
    expect(open.responseOverdue).toBe(true);
    const resolved = buildDisputeRows([disputeFixture({ status: "RESOLVED" })], "2026-10-10")[0]!;
    expect(resolved.responseOverdue).toBe(false);
    const noDeadline = buildDisputeRows(
      [disputeFixture({ response_due_date: undefined })],
      "2026-10-10",
    )[0]!;
    expect(noDeadline.responseOverdue).toBe(false);
    expect(noDeadline.sample).toBe(false);
  });

  it("is newest first and tolerates disputes with no transactions", () => {
    const rows = buildDisputeRows(
      [
        disputeFixture({ dispute_id: "PP-D-OLD", create_time: "2026-10-01T00:00:00Z" }),
        disputeFixture({ dispute_id: "PP-D-NEW", disputed_transactions: [] }),
      ],
      "2026-10-10",
    );
    expect(rows.map((r) => r.id)).toEqual(["PP-D-NEW", "PP-D-OLD"]);
    expect(rows[0]?.buyerName).toBe("");
    expect(buildDisputeRows([], "2026-10-10")).toEqual([]);
  });
});

describe("console transaction rows (reconciliation, read-only)", () => {
  it("projects the full demo loop ledger: payment in, payout out (signed)", async () => {
    const client = new MockPayPalClient({ sampleDispute: false });
    const invoice = await client.createInvoice({
      recipient: ANA,
      items: [{ name: "Logo work", quantity: "1", unit_amount: { currency_code: "USD", value: "450.00" } }],
    });
    await client.sendInvoice(invoice.id);
    await client.recordInvoicePayment(invoice.id, { value: "450.00", currency_code: "USD" });
    await client.createPayout({
      items: [{ recipient: MARCO, amount: { currency_code: "USD", value: "200.00" }, note: "Brand work share" }],
    });

    const rows = buildTransactionRows(await client.listTransactions());
    expect(rows).toHaveLength(2);
    // Newest first: the payout (negative) precedes the invoice payment.
    expect(rows[0]?.amount).toBe("-200.00");
    expect(rows[0]?.amountValue).toBe(-200);
    expect(rows[0]?.eventCode).toBe("T2001");
    expect(rows[1]?.amount).toBe("450.00");
    expect(rows[1]?.status).toBe("S");
    expect(rows[1]?.subject).toContain("Payment for invoice");
    expect(buildTransactionRows([])).toEqual([]);
  });
});

describe("summary counts + grid states for the read-only surfaces", () => {
  it("counts disputes and transactions alongside the money grids", async () => {
    const client = new MockPayPalClient({ sampleDispute: true });
    const invoice = await client.createInvoice({
      recipient: ANA,
      items: [{ name: "Icons", quantity: "1", unit_amount: { currency_code: "USD", value: "120.00" } }],
    });
    await client.sendInvoice(invoice.id);
    await client.recordInvoicePayment(invoice.id, { value: "120.00", currency_code: "USD" });

    const summary = computeSummary({
      invoices: await client.listInvoices(),
      orders: await client.listOrders(),
      payouts: await client.listPayouts(),
      disputes: await client.listDisputes(),
      transactions: await client.listTransactions(),
      plans: [],
      activity: [],
      referenceDate: "2026-10-10",
    });
    expect(summary.counts.disputes).toBe(1);
    expect(summary.counts.transactions).toBe(1);
    expect(summary.openDisputes).toBe(1);
  });

  it("both new grids resolve their own empty-state copy", () => {
    const disputes = resolveGridOverlay({ grid: "disputes", status: "ready", totalRows: 0 });
    expect(disputes.kind).toBe("empty");
    expect(disputes.title).toBe("No disputes on record");
    expect(disputes.hint).toContain("Sample");
    const transactions = resolveGridOverlay({ grid: "transactions", status: "ready", totalRows: 0 });
    expect(transactions.kind).toBe("empty");
    expect(transactions.title).toBe("No transactions yet");
  });
});
