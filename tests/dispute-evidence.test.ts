import { describe, expect, it } from "vitest";
import {
  DisputeEvidenceError,
  buildDisputeEvidenceSummary,
  getDisputeEvidenceSummary,
  humanizeDisputeReason,
} from "../src/lib/disputes";
import { MockPayPalClient } from "../src/lib/paypal/mock";
import type { Dispute, Invoice, Transaction } from "../src/lib/types";

const REF = "2026-10-10";
const SAM = { name: "Sam Rivera", email_address: "sam@example.com" };

function disputeFixture(overrides: Partial<Dispute> = {}): Dispute {
  return {
    dispute_id: "PP-D-TEST-1",
    create_time: "2026-10-05T09:00:00Z",
    update_time: "2026-10-06T09:00:00Z",
    disputed_transactions: [{ seller_transaction_id: "TXN-TEST-1", buyer: SAM }],
    amount: { currency_code: "USD", value: "120.00" },
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    status: "WAITING_FOR_SELLER_RESPONSE",
    dispute_life_cycle_stage: "INQUIRY",
    response_due_date: "2026-10-29T23:59:59Z",
    ...overrides,
  };
}

function invoiceFixture(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "INV2-TEST-1",
    status: "PAID",
    detail: { invoice_number: "LP-000777" },
    invoicer: { name: "Toni Seller", email_address: "seller@example.com" },
    primary_recipients: [{ billing_info: SAM }],
    items: [{ name: "Landing page copy", quantity: "1", unit_amount: { currency_code: "USD", value: "120.00" } }],
    amount: { currency_code: "USD", value: "120.00" },
    due_amount: { currency_code: "USD", value: "0.00" },
    links: [],
    ...overrides,
  };
}

function txnFixture(overrides: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: "TXN-TEST-1",
    transaction_event_code: "T0006",
    transaction_initiation_date: "2026-10-04T10:00:00Z",
    transaction_amount: { currency_code: "USD", value: "120.00" },
    transaction_status: "S",
    transaction_subject: "Payment for invoice LP-000777",
    ...overrides,
  };
}

describe("dispute reason labels", () => {
  it("humanizes known codes and falls back deterministically for unknown ones", () => {
    expect(humanizeDisputeReason("MERCHANDISE_OR_SERVICE_NOT_RECEIVED")).toBe(
      "Merchandise or service not received",
    );
    expect(humanizeDisputeReason("SOME_NEW_CODE")).toBe("Some new code");
  });
});

describe("dispute evidence summary (pure builder)", () => {
  it("summarizes the sample dispute honestly: sample flag kept, no matches invented, delivery always a gap", () => {
    const summary = buildDisputeEvidenceSummary({
      dispute: disputeFixture({ dispute_id: "PP-D-SAMPLE-001", sample: true }),
      transactions: [],
      invoices: [],
      referenceDate: REF,
    });
    expect(summary.sample).toBe(true);
    expect(summary.headline).toContain("Sample dispute");
    expect(summary.reasonLabel).toBe("Merchandise or service not received");
    expect(summary.daysRemaining).toBe(19);
    expect(summary.urgency).toBe("open");
    expect(summary.matchedTransaction).toBeNull();
    expect(summary.matchedInvoice).toBeNull();
    const delivery = summary.checklist.find((c) => c.label.includes("Delivery"));
    expect(delivery?.present).toBe(false);
    expect(summary.gaps.join(" ")).toContain("Delivery / fulfilment proof");
    expect(summary.draftResponse).toContain("NOT SUBMITTED");
    expect(summary.draftResponse).toContain("seeded sample data");
    expect(summary.draftResponse).not.toContain("was delivered");
    expect(summary.disclaimer).toContain("not submitted to PayPal");
  });

  it("matches a transaction by exact seller transaction id and an invoice via its subject", () => {
    const summary = buildDisputeEvidenceSummary({
      dispute: disputeFixture(),
      transactions: [txnFixture()],
      invoices: [invoiceFixture()],
      referenceDate: REF,
    });
    expect(summary.matchedTransaction?.transactionId).toBe("TXN-TEST-1");
    expect(summary.matchedInvoice?.invoiceNumber).toBe("LP-000777");
    expect(summary.matchedInvoice?.matchedVia).toBe("transaction_subject");
    expect(summary.checklist.find((c) => c.label.includes("Matching seller transaction"))?.present).toBe(true);
    expect(summary.checklist.find((c) => c.label.includes("Matching invoice"))?.present).toBe(true);
    expect(summary.facts.join(" ")).toContain("Payment for invoice LP-000777");
  });

  it("does not match a transaction on a different id, and matches an invoice by buyer + amount alone", () => {
    const summary = buildDisputeEvidenceSummary({
      dispute: disputeFixture(),
      transactions: [txnFixture({ transaction_id: "TXN-OTHER", transaction_subject: "Unrelated payment" })],
      invoices: [invoiceFixture()],
      referenceDate: REF,
    });
    expect(summary.matchedTransaction).toBeNull();
    expect(summary.matchedInvoice?.matchedVia).toBe("buyer_and_amount");
  });

  it("does not match an invoice when the amount disagrees, even for the same buyer", () => {
    const summary = buildDisputeEvidenceSummary({
      dispute: disputeFixture(),
      transactions: [],
      invoices: [invoiceFixture({ amount: { currency_code: "USD", value: "99.00" } })],
      referenceDate: REF,
    });
    expect(summary.matchedInvoice).toBeNull();
  });

  it("flags an overdue open dispute and puts the overdue warning first in the gaps", () => {
    const summary = buildDisputeEvidenceSummary({
      dispute: disputeFixture({ response_due_date: "2026-10-08T23:59:59Z" }),
      transactions: [],
      invoices: [],
      referenceDate: REF,
    });
    expect(summary.daysRemaining).toBe(-2);
    expect(summary.urgency).toBe("overdue");
    expect(summary.headline).toContain("response overdue by 2 day(s)");
    expect(summary.gaps[0]).toContain("past its seller-response deadline");
  });

  it("marks a deadline within three days as due_soon and a resolved dispute as resolved", () => {
    const soon = buildDisputeEvidenceSummary({
      dispute: disputeFixture({ response_due_date: "2026-10-12T00:00:00Z" }),
      transactions: [],
      invoices: [],
      referenceDate: REF,
    });
    expect(soon.daysRemaining).toBe(2);
    expect(soon.urgency).toBe("due_soon");

    const resolved = buildDisputeEvidenceSummary({
      dispute: disputeFixture({ status: "RESOLVED", response_due_date: "2026-10-01T00:00:00Z" }),
      transactions: [],
      invoices: [],
      referenceDate: REF,
    });
    expect(resolved.isOpen).toBe(false);
    expect(resolved.urgency).toBe("resolved");
  });

  it("handles a dispute with no response deadline: daysRemaining is null and the deadline is a checklist gap", () => {
    const dispute = disputeFixture();
    delete dispute.response_due_date;
    const summary = buildDisputeEvidenceSummary({
      dispute,
      transactions: [],
      invoices: [],
      referenceDate: REF,
    });
    expect(summary.daysRemaining).toBeNull();
    expect(summary.urgency).toBe("open");
    expect(summary.checklist.find((c) => c.label.includes("deadline"))?.present).toBe(false);
  });
});

describe("dispute evidence summary (adapter-backed)", () => {
  it("drafts a summary for the mock sample dispute through the client", async () => {
    const client = new MockPayPalClient();
    const summary = await getDisputeEvidenceSummary(client, "PP-D-SAMPLE-001", REF);
    expect(summary.sample).toBe(true);
    expect(summary.buyerName).toBe("Sam Rivera");
    expect(summary.amount).toBe("120.00");
  });

  it("matches a real mock invoice by buyer + amount after it is paid", async () => {
    const client = new MockPayPalClient();
    const draft = await client.createInvoice({
      recipient: SAM,
      items: [{ name: "Landing page copy", quantity: "1", unit_amount: { currency_code: "USD", value: "120.00" } }],
    });
    await client.sendInvoice(draft.id);
    await client.recordInvoicePayment(draft.id, { currency_code: "USD", value: "120.00" });
    const summary = await getDisputeEvidenceSummary(client, "PP-D-SAMPLE-001", REF);
    // The invoice payment's transaction id is a fresh id, not the dispute's
    // seller transaction id — the transaction match honestly stays empty,
    // while the invoice matches on buyer email + currency + amount.
    expect(summary.matchedTransaction).toBeNull();
    expect(summary.matchedInvoice?.invoiceId).toBe(draft.id);
    expect(summary.matchedInvoice?.matchedVia).toBe("buyer_and_amount");
  });

  it("throws a 404 DisputeEvidenceError for an unknown dispute id", async () => {
    const client = new MockPayPalClient();
    await expect(getDisputeEvidenceSummary(client, "PP-D-NOPE", REF)).rejects.toMatchObject({
      name: "DisputeEvidenceError",
      status: 404,
    });
    await expect(getDisputeEvidenceSummary(client, "PP-D-NOPE", REF)).rejects.toBeInstanceOf(
      DisputeEvidenceError,
    );
  });
});
