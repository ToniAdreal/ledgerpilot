import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SandboxPayPalClient, type FetchFn } from "@/lib/paypal";
import type { WebhookEvent } from "@/lib/types";

/**
 * Sandbox request-id (idempotency) tests — every mutating call
 * carries a unique `PayPal-Request-Id`, exercised against a stub
 * fetch with FAKE credentials and a FIXED clock (so distinct ids
 * can only come from the per-client sequence). No network, no
 * real PayPal account.
 */

const ANA = { name: "Ana Example", email_address: "ana@example.com" };
const MARCO = { name: "Marco", email_address: "marco@example.com" };
const FIXED_MS = Date.parse("2026-10-10T12:00:00Z");
const HEADER = "PayPal-Request-Id";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeStubFetch() {
  const requests: RecordedRequest[] = [];
  const invoices = new Map<string, Record<string, unknown>>();
  const orders = new Map<string, Record<string, unknown>>();
  let invoiceSeq = 0;

  const fetchFn: FetchFn = async (url, init) => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url, method, headers, body });
    const path = new URL(url).pathname;

    if (path === "/v1/oauth2/token") {
      return json(200, { access_token: "test-token", token_type: "Bearer", expires_in: 3600 });
    }
    if (path === "/v2/invoicing/invoices" && method === "POST") {
      invoiceSeq += 1;
      const id = `INV2-STUB-${invoiceSeq}`;
      const parsed = JSON.parse(body) as Record<string, any>;
      invoices.set(id, {
        id,
        status: "DRAFT",
        detail: parsed.detail,
        invoicer: { name: { given_name: "Demo", surname: "Seller" }, email_address: "seller@example.com" },
        primary_recipients: parsed.primary_recipients,
        items: parsed.items,
        amount: { currency_code: "USD", value: "450.00" },
        due_amount: { currency_code: "USD", value: "450.00" },
        links: [],
      });
      return json(201, {
        links: [{ href: `https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${id}`, rel: "self", method: "GET" }],
      });
    }
    const invoiceMatch = path.match(/^\/v2\/invoicing\/invoices\/([^/]+)$/);
    if (invoiceMatch && method === "GET") {
      const invoice = invoices.get(invoiceMatch[1]!);
      if (!invoice) return json(404, { name: "RESOURCE_NOT_FOUND", message: "Invoice not found." });
      return json(200, invoice);
    }
    if (path.match(/^\/v2\/invoicing\/invoices\/[^/]+\/send$/) && method === "POST") {
      const invoice = invoices.get(path.split("/")[4]!)!;
      invoice.status = "SENT";
      return new Response(null, { status: 202 });
    }
    if (path.match(/^\/v2\/invoicing\/invoices\/[^/]+\/remind$/) && method === "POST") {
      return new Response(null, { status: 204 });
    }
    if (path.match(/^\/v2\/invoicing\/invoices\/[^/]+\/payments$/) && method === "POST") {
      const invoice = invoices.get(path.split("/")[4]!)!;
      invoice.status = "PAID";
      invoice.due_amount = { currency_code: "USD", value: "0.00" };
      return json(201, { payment_id: "PAY-STUB-1" });
    }
    if (path === "/v2/invoicing/invoices" && method === "GET") {
      return json(200, { total_items: invoices.size, items: [...invoices.values()] });
    }
    if (path === "/v2/checkout/orders" && method === "POST") {
      const parsed = JSON.parse(body) as Record<string, any>;
      const order = { id: "ORDER-STUB-1", status: "CREATED", intent: parsed.intent, purchase_units: parsed.purchase_units, links: [] };
      orders.set(order.id, order);
      return json(201, order);
    }
    const captureMatch = path.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/);
    if (captureMatch && method === "POST") {
      const order = orders.get(captureMatch[1]!) as Record<string, any>;
      order.status = "COMPLETED";
      return json(200, order);
    }
    const orderMatch = path.match(/^\/v2\/checkout\/orders\/([^/]+)$/);
    if (orderMatch && method === "GET") {
      const order = orders.get(orderMatch[1]!);
      if (!order) return json(404, { name: "RESOURCE_NOT_FOUND", message: "Order not found." });
      return json(200, order);
    }
    if (path === "/v1/payments/payouts" && method === "POST") {
      const parsed = JSON.parse(body) as Record<string, any>;
      return json(201, {
        batch_header: { payout_batch_id: "BATCH-STUB-1", batch_status: "SUCCESS", time_created: "2026-10-10T12:00:00Z", sender_batch_header: parsed.sender_batch_header },
        items: (parsed.items as Array<any>).map((item, idx) => ({ payout_item_id: `ITEM-STUB-${idx + 1}`, transaction_status: "SUCCESS", payout_item: item })),
        links: [],
      });
    }
    if (path === "/v1/payments/payouts" && method === "GET") return json(200, { total_items: 0, items: [] });
    if (path === "/v1/customer/disputes" && method === "GET") return json(200, { items: [] });
    if (path === "/v1/reporting/transactions" && method === "GET") return json(200, { transaction_details: [] });
    if (path === "/v1/notifications/verify-webhook-signature" && method === "POST") {
      return json(200, { verification_status: "SUCCESS" });
    }
    return json(404, { name: "NOT_FOUND", message: `Stub has no route for ${method} ${path}` });
  };

  return { fetchFn, requests };
}

function makeClient() {
  const stub = makeStubFetch();
  const client = new SandboxPayPalClient({
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    webhookId: "WH-ID-1",
    fetchFn: stub.fetchFn,
    now: () => FIXED_MS,
  });
  return { client, stub };
}

function apiRequests(stub: ReturnType<typeof makeStubFetch>): RecordedRequest[] {
  return stub.requests.filter((r) => !r.url.endsWith("/v1/oauth2/token"));
}

async function makeSentInvoice(client: SandboxPayPalClient) {
  const draft = await client.createInvoice({
    recipient: ANA,
    items: [{ name: "Logo work", quantity: "1", unit_amount: { currency_code: "USD", value: "450.00" } }],
  });
  return client.sendInvoice(draft.id);
}

describe("sandbox PayPal-Request-Id", () => {
  it("carries a shaped id on the create-invoice POST and none on the follow-up GET or the token fetch", async () => {
    const { client, stub } = makeClient();
    const draft = await client.createInvoice({
      recipient: ANA,
      items: [{ name: "Logo work", quantity: "1", unit_amount: { currency_code: "USD", value: "450.00" } }],
    });
    expect(draft.id).toBe("INV2-STUB-1");
    const createReq = stub.requests.find((r) => r.method === "POST" && r.url.endsWith("/v2/invoicing/invoices"))!;
    expect(createReq.headers[HEADER]).toMatch(new RegExp(`^ledgerpilot-req-${FIXED_MS}-\\d+$`));
    const getReq = stub.requests.find((r) => r.method === "GET" && r.url.endsWith("/v2/invoicing/invoices/INV2-STUB-1"))!;
    expect(getReq.headers[HEADER]).toBeUndefined();
    const tokenReq = stub.requests.find((r) => r.url.endsWith("/v1/oauth2/token"))!;
    expect(tokenReq.headers[HEADER]).toBeUndefined();
  });

  it("mints a distinct id for every mutating invoice call at a fixed clock", async () => {
    const { client, stub } = makeClient();
    const sent = await makeSentInvoice(client);
    await client.sendInvoiceReminder(sent.id);
    await client.recordInvoicePayment(sent.id, { value: "450.00", currency_code: "USD" });
    const ids = apiRequests(stub)
      .filter((r) => r.method === "POST")
      .map((r) => r.headers[HEADER]);
    // create, send, remind, record-payment — four mutations.
    expect(ids).toHaveLength(4);
    for (const id of ids) expect(id).toMatch(new RegExp(`^ledgerpilot-req-${FIXED_MS}-\\d+$`));
    expect(new Set(ids).size).toBe(4);
  });

  it("gives two identical payout calls different ids (a new logical call is not a retry)", async () => {
    const { client, stub } = makeClient();
    const input = { items: [{ recipient: MARCO, amount: { currency_code: "USD" as const, value: "200.00" } }] };
    await client.createPayout(input);
    await client.createPayout(input);
    const ids = stub.requests
      .filter((r) => r.method === "POST" && r.url.endsWith("/v1/payments/payouts"))
      .map((r) => r.headers[HEADER]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("carries distinct ids on order create and capture, and none on order GETs", async () => {
    const { client, stub } = makeClient();
    const order = await client.createOrder({ description: "Studio cable pack", amount: { currency_code: "USD", value: "59.00" } });
    await client.captureOrder(order.id);
    await client.listOrders();
    const posts = apiRequests(stub).filter((r) => r.method === "POST");
    expect(posts.map((r) => r.headers[HEADER])).toHaveLength(2);
    expect(new Set(posts.map((r) => r.headers[HEADER])).size).toBe(2);
    for (const get of apiRequests(stub).filter((r) => r.method === "GET")) {
      expect(get.headers[HEADER]).toBeUndefined();
    }
  });

  it("carries no id on any read-only surface", async () => {
    const { client, stub } = makeClient();
    await client.listInvoices();
    await client.listPayouts();
    await client.listDisputes();
    await client.listTransactions();
    expect(apiRequests(stub).length).toBeGreaterThan(0);
    for (const req of apiRequests(stub)) {
      expect(req.method).toBe("GET");
      expect(req.headers[HEADER]).toBeUndefined();
    }
  });

  it("carries no id on webhook-signature verification (a query, not a mutation)", async () => {
    const { client, stub } = makeClient();
    const event: WebhookEvent = {
      id: "WH-EVENT-1",
      create_time: "2026-10-10T12:00:00Z",
      resource_type: "invoice",
      event_type: "INVOICING.INVOICE.PAID",
      summary: "Invoice was paid",
      resource: { id: "INV2-STUB-1" },
      event_version: "1.0",
      resource_version: "2.0",
    };
    await expect(
      client.verifyWebhookSignature(
        {
          "paypal-transmission-id": "transmission-1",
          "paypal-transmission-sig": "good-sig",
          "paypal-transmission-time": "2026-10-10T12:00:00Z",
          "paypal-cert-url": "https://api.sandbox.paypal.com/certs/CERT-1",
          "paypal-auth-algo": "SHA256withRSA",
        },
        event,
      ),
    ).resolves.toBe(true);
    const verifyReq = stub.requests.find((r) => r.url.endsWith("/v1/notifications/verify-webhook-signature"))!;
    expect(verifyReq.method).toBe("POST");
    expect(verifyReq.headers[HEADER]).toBeUndefined();
  });

  it("never puts a credential in the id", async () => {
    const { client, stub } = makeClient();
    await makeSentInvoice(client);
    for (const req of stub.requests) {
      const id = req.headers[HEADER];
      if (id === undefined) continue;
      expect(id).not.toContain("fake-client-id");
      expect(id).not.toContain("fake-client-secret");
      expect(id).not.toContain("test-token");
    }
  });

  it("is documented in the README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("PayPal-Request-Id");
    expect(readme).toContain("idempotency");
  });
});
