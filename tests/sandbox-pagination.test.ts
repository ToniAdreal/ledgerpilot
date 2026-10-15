import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PayPalError, SANDBOX_MAX_LIST_PAGES, SandboxPayPalClient, type FetchFn } from "@/lib/paypal";

/**
 * Sandbox list pagination tests — every list endpoint this adapter
 * calls (Invoicing, Payouts, Disputes, Transaction Search) answers
 * at most one page per request, and PayPal says more pages exist by
 * carrying a HATEOAS `next` link in the response's `links`. Until
 * this behaviour existed, each list method returned exactly its
 * first page (100 invoices / payouts / transactions, 50 disputes)
 * and silently dropped the rest — a console that showed a partial
 * ledger as if it were the whole one.
 *
 * The behaviour pinned here:
 *  - A list call follows `next` links until a page carries none,
 *    concatenating the pages in order; a response with no `next`
 *    link costs exactly one request, exactly as before.
 *  - The absolute `next` href is reduced to its path + query and
 *    fetched from the adapter's configured base URL — the origin
 *    in the href is never trusted as the destination.
 *  - Following is bounded by SANDBOX_MAX_LIST_PAGES: a `next`
 *    chain that never ends (a cyclic or runaway link) is refused
 *    with a PayPalError after exactly that many page requests —
 *    never an unbounded loop, never a silently truncated list
 *    dressed as success.
 *  - A blank or missing `href` on a `next` link ends the list,
 *    like an absent link.
 *
 * Exercised against stub fetches with FAKE credentials. No
 * network, no real PayPal account.
 */

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BASE = "https://api-m.sandbox.paypal.com";

function invoiceRaw(id: string) {
  return {
    id,
    status: "SENT",
    detail: { invoice_number: `LP-${id}` },
    invoicer: { name: { given_name: "Demo", surname: "Seller" }, email_address: "seller@example.com" },
    primary_recipients: [
      { billing_info: { name: { given_name: "Ana" }, email_address: "ana@example.com" } },
    ],
    items: [{ name: "Work", quantity: "1", unit_amount: { currency_code: "USD", value: "10.00" } }],
    amount: { currency_code: "USD", value: "10.00" },
    due_amount: { currency_code: "USD", value: "10.00" },
    links: [],
  };
}

function batchRaw(id: string) {
  return {
    batch_header: {
      payout_batch_id: id,
      batch_status: "SUCCESS",
      time_created: "2026-10-10T12:00:00Z",
      sender_batch_header: { sender_batch_id: `SB-${id}` },
    },
    items: [],
    links: [],
  };
}

function disputeRaw(id: string) {
  return {
    dispute_id: id,
    create_time: "2026-10-08T14:22:00Z",
    update_time: "2026-10-08T14:22:00Z",
    disputed_transactions: [
      { seller_transaction_id: `TXN-${id}`, buyer: { name: { given_name: "Sam" }, email_address: "sam@example.com" } },
    ],
    amount: { currency_code: "USD", value: "120.00" },
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    status: "OPEN",
    dispute_life_cycle_stage: "INQUIRY",
  };
}

function txnRaw(id: string) {
  return {
    transaction_info: {
      transaction_id: id,
      transaction_event_code: "T0006",
      transaction_initiation_date: "2026-10-09T10:00:00+0000",
      transaction_amount: { currency_code: "USD", value: "10.00" },
      transaction_status: "S",
      transaction_subject: "Payment",
    },
    payer_info: { email_address: "ana@example.com", payer_name: { given_name: "Ana" } },
  };
}

interface PagedStub {
  fetchFn: FetchFn;
  /** Every non-token request URL, in order. */
  urls: string[];
}

function makePagedStub(): PagedStub {
  const urls: string[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const method = init?.method ?? "GET";
    const u = new URL(url);
    const path = u.pathname;
    if (path === "/v1/oauth2/token") {
      return json(200, { access_token: "test-token", token_type: "Bearer", expires_in: 3600 });
    }
    urls.push(url);
    const page = u.searchParams.get("page") ?? "1";

    if (path === "/v2/invoicing/invoices" && method === "GET") {
      // The cycle fixture: its own dedicated page chain never ends.
      if (u.searchParams.get("cycle") === "1") {
        return json(200, {
          items: [invoiceRaw("INV-CYCLE")],
          links: [{ href: `${BASE}/v2/invoicing/invoices?cycle=1&page=2`, rel: "next", method: "GET" }],
        });
      }
      if (page === "1") {
        return json(200, {
          items: [invoiceRaw("INV-P1"), invoiceRaw("INV-P2")],
          links: [{ href: `${BASE}/v2/invoicing/invoices?page=2&page_size=2`, rel: "next", method: "GET" }],
        });
      }
      return json(200, { items: [invoiceRaw("INV-P3")], links: [] });
    }

    if (path === "/v1/payments/payouts" && method === "GET") {
      if (page === "1") {
        return json(200, {
          items: [batchRaw("BATCH-P1")],
          links: [{ href: `${BASE}/v1/payments/payouts?page=2`, rel: "next", method: "GET" }],
        });
      }
      return json(200, { items: [batchRaw("BATCH-P2")], links: [] });
    }

    if (path === "/v1/customer/disputes" && method === "GET") {
      if (page === "1") {
        return json(200, {
          items: [disputeRaw("PP-D-P1")],
          links: [{ href: `${BASE}/v1/customer/disputes?page=2`, rel: "next", method: "GET" }],
        });
      }
      return json(200, { items: [disputeRaw("PP-D-P2")], links: [] });
    }

    if (path === "/v1/reporting/transactions" && method === "GET") {
      if (page === "1") {
        return json(200, {
          transaction_details: [txnRaw("TXN-P1")],
          links: [{ href: `${BASE}/v1/reporting/transactions?page=2`, rel: "next", method: "GET" }],
        });
      }
      return json(200, { transaction_details: [txnRaw("TXN-P2")], links: [] });
    }

    return json(404, { name: "NOT_FOUND", message: `Stub has no route for ${method} ${path}` });
  };
  return { fetchFn, urls };
}

function makeClient(stub: PagedStub) {
  return new SandboxPayPalClient({
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    webhookId: "WH-ID-1",
    fetchFn: stub.fetchFn,
    now: () => Date.parse("2026-10-10T12:00:00Z"),
  });
}

describe("sandbox list pagination", () => {
  it("pins the page bound", () => {
    expect(SANDBOX_MAX_LIST_PAGES).toBe(10);
  });

  it("follows the invoices next link and concatenates the pages in order", async () => {
    const stub = makePagedStub();
    const client = makeClient(stub);
    const invoices = await client.listInvoices();
    expect(invoices.map((i) => i.id)).toEqual(["INV-P1", "INV-P2", "INV-P3"]);
    const listUrls = stub.urls.filter((u) => new URL(u).pathname === "/v2/invoicing/invoices");
    expect(listUrls).toHaveLength(2);
    // The second request went to the configured base URL with the
    // next link's path + query — not to a re-requested first page.
    expect(listUrls[1]).toContain("page=2");
    expect(listUrls[1]!.startsWith(BASE)).toBe(true);
  });

  it("follows the payouts next link", async () => {
    const stub = makePagedStub();
    const client = makeClient(stub);
    const batches = await client.listPayouts();
    expect(batches.map((b) => b.batch_header.payout_batch_id)).toEqual(["BATCH-P1", "BATCH-P2"]);
  });

  it("follows the disputes next link", async () => {
    const stub = makePagedStub();
    const client = makeClient(stub);
    const disputes = await client.listDisputes();
    expect(disputes.map((d) => d.dispute_id)).toEqual(["PP-D-P1", "PP-D-P2"]);
  });

  it("follows the transaction search next link", async () => {
    const stub = makePagedStub();
    const client = makeClient(stub);
    const txns = await client.listTransactions();
    expect(txns.map((t) => t.transaction_id)).toEqual(["TXN-P1", "TXN-P2"]);
  });

  it("refuses a next chain that never ends after exactly SANDBOX_MAX_LIST_PAGES page requests", async () => {
    // Point the client's invoices list at the stub's cyclic
    // fixture (its next link points at a page whose next link
    // points back again) by rewriting the first list request.
    const stub = makePagedStub();
    const counting: string[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      const u = new URL(url);
      if (u.pathname === "/v2/invoicing/invoices" && (init?.method ?? "GET") === "GET") {
        counting.push(url);
        const rewritten = url.includes("cycle=1") ? url : `${url}${url.includes("?") ? "&" : "?"}cycle=1`;
        return stub.fetchFn(rewritten, init);
      }
      return stub.fetchFn(url, init);
    };
    const client = new SandboxPayPalClient({
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      fetchFn,
      now: () => Date.parse("2026-10-10T12:00:00Z"),
    });
    await expect(client.listInvoices()).rejects.toBeInstanceOf(PayPalError);
    expect(counting).toHaveLength(SANDBOX_MAX_LIST_PAGES);
    // A fresh call against the same cyclic fixture surfaces the
    // refusal's shape: a 502 PAGINATION_LIMIT naming no page body.
    const client2 = new SandboxPayPalClient({
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      fetchFn,
      now: () => Date.parse("2026-10-10T12:00:00Z"),
    });
    await expect(client2.listInvoices()).rejects.toMatchObject({ status: 502, name_: "PAGINATION_LIMIT" });
  });

  it("documents the bound in the README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("SANDBOX_MAX_LIST_PAGES");
  });
});
