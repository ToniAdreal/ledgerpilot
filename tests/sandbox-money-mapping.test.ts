import { describe, expect, it } from "vitest";
import { SandboxPayPalClient, type FetchFn } from "@/lib/paypal";
import { computeSummary } from "@/lib/console/read-models";

/**
 * Sandbox money-mapping hygiene — a malformed amount string in a
 * PayPal response must fall back exactly like a missing amount,
 * never carry verbatim into the domain types where every consumer
 * converts it with Number(...) and gets NaN (KPI totals, invoice
 * line totals, record-payment's amount-due arithmetic). Exercised
 * against a stub fetch with fake credentials; no network.
 */

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BAD_INVOICE = {
  id: "INV2-BAD-AMOUNT",
  status: "SENT",
  detail: { invoice_number: "LP-BAD-1", payment_term: { due_date: "2026-10-20" } },
  primary_recipients: [{ billing_info: { name: "Ana Example", email_address: "ana@example.com" } }],
  items: [{ name: "Logo work", quantity: "1", unit_amount: { currency_code: "USD", value: "450.00" } }],
  amount: { currency_code: "USD", value: "not-a-number" },
  due_amount: { currency_code: "USD", value: "also-not-a-number" },
  links: [],
};

const BAD_ITEMS_INVOICE = {
  id: "INV2-BAD-ITEMS",
  status: "SENT",
  detail: { invoice_number: "LP-BAD-2" },
  primary_recipients: [{ billing_info: { name: "Marco", email_address: "marco@example.com" } }],
  items: [
    { name: "Bad quantity", quantity: "abc", unit_amount: { currency_code: "USD", value: "450.00" } },
    { name: "Bad unit", quantity: "2", unit_amount: { currency_code: "USD", value: "oops" } },
    { name: "Good", quantity: "2", unit_amount: { currency_code: "USD", value: "50.00" } },
  ],
  links: [],
};

function makeClient() {
  const fetchFn: FetchFn = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/v1/oauth2/token") {
      return json(200, { access_token: "test-token", token_type: "Bearer", expires_in: 3600 });
    }
    if (path === "/v2/invoicing/invoices") {
      return json(200, { total_items: 2, items: [BAD_INVOICE, BAD_ITEMS_INVOICE] });
    }
    if (path === "/v1/customer/disputes") {
      return json(200, {
        items: [
          {
            dispute_id: "PP-D-BAD",
            create_time: "2026-10-08T14:22:00Z",
            disputed_transactions: [
              { seller_transaction_id: "TXN-1", buyer: { name: "Sam", email_address: "sam@example.com" } },
            ],
            amount: { currency_code: "USD", value: "garbage" },
            reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
            status: "OPEN",
            dispute_life_cycle_stage: "INQUIRY",
          },
        ],
      });
    }
    if (path === "/v1/reporting/transactions") {
      return json(200, {
        transaction_details: [
          {
            transaction_info: {
              transaction_id: "TXN-GOOD",
              transaction_event_code: "T0006",
              transaction_initiation_date: "2026-10-09T10:00:00Z",
              transaction_amount: { currency_code: "USD", value: "-200.00" },
              transaction_status: "S",
            },
            payer_info: { email_address: "ana@example.com", payer_name: { given_name: "Ana" } },
          },
          {
            transaction_info: {
              transaction_id: "TXN-BAD",
              transaction_event_code: "T0006",
              transaction_initiation_date: "2026-10-09T11:00:00Z",
              transaction_amount: { currency_code: "USD", value: "1,200.00" },
              transaction_status: "S",
            },
            payer_info: { email_address: "ana@example.com", payer_name: { given_name: "Ana" } },
          },
        ],
      });
    }
    return json(404, { name: "NOT_FOUND", message: `no stub route for ${path}` });
  };
  return new SandboxPayPalClient({
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    fetchFn,
    now: () => Date.parse("2026-10-10T12:00:00Z"),
  });
}

describe("sandbox money mapping", () => {
  it("falls back to the items total when an invoice amount and due amount are malformed", async () => {
    const invoices = await makeClient().listInvoices();
    const bad = invoices.find((i) => i.id === "INV2-BAD-AMOUNT")!;
    expect(bad.amount).toEqual({ currency_code: "USD", value: "450.00" });
    expect(bad.due_amount).toEqual({ currency_code: "USD", value: "450.00" });
  });

  it("sanitises a non-numeric quantity to 1 and a malformed unit amount to the zero fallback, so the items total is never NaN", async () => {
    const invoices = await makeClient().listInvoices();
    const bad = invoices.find((i) => i.id === "INV2-BAD-ITEMS")!;
    expect(bad.items[0]?.quantity).toBe("1");
    expect(bad.items[1]?.unit_amount).toEqual({ currency_code: "USD", value: "0.00" });
    // 1 x 450.00 + 2 x 0.00 + 2 x 50.00
    expect(bad.amount).toEqual({ currency_code: "USD", value: "550.00" });
    expect(bad.due_amount).toEqual({ currency_code: "USD", value: "550.00" });
  });

  it("falls back for malformed dispute and transaction amounts, and preserves a valid signed amount verbatim", async () => {
    const client = makeClient();
    const disputes = await client.listDisputes();
    expect(disputes[0]?.amount).toEqual({ currency_code: "USD", value: "0.00" });
    const txns = await client.listTransactions();
    expect(txns.find((t) => t.transaction_id === "TXN-GOOD")?.transaction_amount.value).toBe("-200.00");
    // "1,200.00" is not a plain numeric string PayPal sends; Number(...) on it is NaN, so it falls back.
    expect(txns.find((t) => t.transaction_id === "TXN-BAD")?.transaction_amount).toEqual({
      currency_code: "USD",
      value: "0.00",
    });
  });

  it("keeps console KPI totals finite — no NaN total reaches the summary", async () => {
    const client = makeClient();
    const invoices = await client.listInvoices();
    const disputes = await client.listDisputes();
    const summary = computeSummary({
      invoices,
      orders: [],
      payouts: [],
      disputes,
      transactions: [],
      plans: [],
      activity: [],
      referenceDate: "2026-10-10",
    });
    for (const total of [...summary.outstanding, ...summary.collected]) {
      expect(total.value).not.toContain("NaN");
      expect(Number.isFinite(Number(total.value))).toBe(true);
    }
    // Both bad invoices are SENT and fully due: 450.00 + 550.00.
    expect(summary.outstanding).toEqual([{ currency_code: "USD", value: "1000.00" }]);
  });
});
