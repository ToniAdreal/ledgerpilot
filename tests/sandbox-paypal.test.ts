import { describe, expect, it } from "vitest";
import { PayPalError, SandboxPayPalClient, type FetchFn } from "@/lib/paypal";
import type { WebhookEvent } from "@/lib/types";

/**
 * Sandbox adapter tests — the REST wiring is exercised against a stub
 * fetch with FAKE credentials. No network, no real PayPal account.
 * The stub mimics the documented PayPal response shapes, including the
 * awkward ones: create-invoice returns links only, send returns an
 * empty 202, and Transaction Search nests fields under
 * transaction_info.
 */

const ANA = { name: "Ana Example", email_address: "ana@example.com" };
const MARCO = { name: "Marco", email_address: "marco@example.com" };

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
  let tokenCalls = 0;
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
      tokenCalls += 1;
      return json(200, { access_token: "test-token", token_type: "Bearer", expires_in: 3600 });
    }

    if (path === "/v2/invoicing/invoices" && method === "POST") {
      invoiceSeq += 1;
      const id = `INV2-STUB-${invoiceSeq}`;
      const parsed = JSON.parse(body) as Record<string, any>;
      const total = (parsed.items as Array<any>).reduce(
        (acc, i) => acc + Number(i.quantity) * Number(i.unit_amount.value),
        0,
      );
      const currency = parsed.items[0].unit_amount.currency_code as string;
      invoices.set(id, {
        id,
        status: "DRAFT",
        detail: parsed.detail,
        invoicer: { name: { given_name: "Demo", surname: "Seller" }, email_address: "seller@example.com" },
        primary_recipients: parsed.primary_recipients,
        items: parsed.items,
        amount: { currency_code: currency, value: total.toFixed(2) },
        due_amount: { currency_code: currency, value: total.toFixed(2) },
        links: [],
      });
      // Real PayPal: 201 + HATEOAS links only, no resource body.
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
      const id = path.split("/")[4]!;
      const invoice = invoices.get(id)!;
      invoice.status = "SENT";
      return new Response(null, { status: 202 });
    }
    if (path.match(/^\/v2\/invoicing\/invoices\/[^/]+\/payments$/) && method === "POST") {
      const id = path.split("/")[4]!;
      const invoice = invoices.get(id)!;
      const paid = Number((JSON.parse(body) as any).amount.value as string);
      const due = Number((invoice.due_amount as any).value as string) - paid;
      invoice.due_amount = { currency_code: (invoice.amount as any).currency_code, value: due.toFixed(2) };
      invoice.status = due === 0 ? "PAID" : "PARTIALLY_PAID";
      return json(201, { payment_id: "PAY-STUB-1" });
    }
    if (path === "/v2/invoicing/invoices" && method === "GET") {
      return json(200, { total_items: invoices.size, items: [...invoices.values()] });
    }

    if (path === "/v2/checkout/orders" && method === "POST") {
      const parsed = JSON.parse(body) as Record<string, any>;
      const order = {
        id: "ORDER-STUB-1",
        status: "CREATED",
        intent: parsed.intent,
        purchase_units: parsed.purchase_units,
        links: [],
      };
      orders.set(order.id, order);
      return json(201, order);
    }
    const captureMatch = path.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/);
    if (captureMatch && method === "POST") {
      const order = orders.get(captureMatch[1]!) as Record<string, any>;
      order.status = "COMPLETED";
      const unit = (order.purchase_units as Array<any>)[0];
      unit.payments = { captures: [{ id: "CAP-STUB-1", status: "COMPLETED", amount: unit.amount }] };
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
        batch_header: {
          payout_batch_id: "BATCH-STUB-1",
          batch_status: "SUCCESS",
          time_created: "2026-10-10T12:00:00Z",
          sender_batch_header: parsed.sender_batch_header,
        },
        items: (parsed.items as Array<any>).map((item, idx) => ({
          payout_item_id: `ITEM-STUB-${idx + 1}`,
          transaction_status: "SUCCESS",
          payout_item: item,
        })),
        links: [],
      });
    }
    if (path === "/v1/payments/payouts" && method === "GET") {
      return json(200, { total_items: 0, items: [] });
    }

    if (path === "/v1/customer/disputes" && method === "GET") {
      return json(200, {
        items: [
          {
            dispute_id: "PP-D-STUB-1",
            create_time: "2026-10-08T14:22:00Z",
            update_time: "2026-10-08T14:22:00Z",
            disputed_transactions: [
              { seller_transaction_id: "TXN-STUB-1", buyer: { name: { given_name: "Sam" }, email_address: "sam@example.com" } },
            ],
            amount: { currency_code: "USD", value: "120.00" },
            reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
            status: "WAITING_FOR_SELLER_RESPONSE",
            dispute_life_cycle_stage: "INQUIRY",
          },
        ],
      });
    }

    if (path === "/v1/reporting/transactions" && method === "GET") {
      return json(200, {
        transaction_details: [
          {
            transaction_info: {
              transaction_id: "TXN-STUB-9",
              transaction_event_code: "T0006",
              transaction_initiation_date: "2026-10-09T10:00:00+0000",
              transaction_amount: { currency_code: "USD", value: "450.00" },
              transaction_status: "S",
              transaction_subject: "Payment for invoice LP-000001",
            },
            payer_info: { email_address: "ana@example.com", payer_name: { given_name: "Ana", surname: "Example" } },
          },
        ],
      });
    }

    if (path === "/v1/notifications/verify-webhook-signature" && method === "POST") {
      const parsed = JSON.parse(body) as Record<string, any>;
      return json(200, {
        verification_status: parsed.transmission_sig === "good-sig" ? "SUCCESS" : "FAILURE",
      });
    }

    return json(404, { name: "NOT_FOUND", message: `Stub has no route for ${method} ${path}` });
  };

  return { fetchFn, requests, tokenCalls: () => tokenCalls };
}

function makeClient(nowRef: { ms: number }, webhookId = "WH-ID-1") {
  const stub = makeStubFetch();
  const client = new SandboxPayPalClient({
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    webhookId,
    fetchFn: stub.fetchFn,
    now: () => nowRef.ms,
  });
  return { client, stub };
}

const T0 = { ms: Date.parse("2026-10-10T12:00:00Z") };

describe("sandbox auth", () => {
  it("fetches an OAuth token with Basic auth, then caches it across calls", async () => {
    const { client, stub } = makeClient({ ...T0 });
    await client.listInvoices();
    await client.listDisputes();
    expect(stub.tokenCalls()).toBe(1);
    const tokenReq = stub.requests.find((r) => r.url.endsWith("/v1/oauth2/token"))!;
    expect(tokenReq.method).toBe("POST");
    expect(tokenReq.headers.Authorization).toBe(
      `Basic ${Buffer.from("fake-client-id:fake-client-secret").toString("base64")}`,
    );
    expect(tokenReq.body).toBe("grant_type=client_credentials");
    const apiReq = stub.requests.find((r) => r.url.includes("/v2/invoicing/invoices"))!;
    expect(apiReq.headers.Authorization).toBe("Bearer test-token");
  });

  it("refetches the token after it expires", async () => {
    const nowRef = { ...T0 };
    const { client, stub } = makeClient(nowRef);
    await client.listInvoices();
    nowRef.ms += 3601 * 1000;
    await client.listInvoices();
    expect(stub.tokenCalls()).toBe(2);
  });
});

describe("sandbox invoicing", () => {
  it("creates via the links-only 201, sends (empty 202), records payment, and maps the resource", async () => {
    const { client, stub } = makeClient({ ...T0 });
    const draft = await client.createInvoice({
      recipient: ANA,
      items: [{ name: "Logo work", quantity: "1", unit_amount: { currency_code: "USD", value: "450.00" } }],
      dueDate: "2026-10-16",
      note: "Brand work",
    });
    expect(draft.id).toBe("INV2-STUB-1");
    expect(draft.status).toBe("DRAFT");
    expect(draft.amount).toEqual({ currency_code: "USD", value: "450.00" });
    expect(draft.invoicer).toEqual({ name: "Demo Seller", email_address: "seller@example.com" });
    expect(draft.primary_recipients[0]?.billing_info).toEqual(ANA);
    expect(draft.detail.payment_term?.due_date).toBe("2026-10-16");

    const createReq = stub.requests.find((r) => r.method === "POST" && r.url.endsWith("/v2/invoicing/invoices"))!;
    const createBody = JSON.parse(createReq.body) as Record<string, any>;
    expect(createBody.primary_recipients[0].billing_info.name).toEqual({ given_name: "Ana", surname: "Example" });
    expect(createBody.detail.payment_term).toEqual({ term_type: "DUE_ON_DATE_SPECIFIED", due_date: "2026-10-16" });

    const sent = await client.sendInvoice(draft.id);
    expect(sent.status).toBe("SENT");
    const partial = await client.recordInvoicePayment(draft.id, { value: "200.00", currency_code: "USD" });
    expect(partial.status).toBe("PARTIALLY_PAID");
    expect(partial.due_amount.value).toBe("250.00");
    const paid = await client.recordInvoicePayment(draft.id, { value: "250.00", currency_code: "USD" });
    expect(paid.status).toBe("PAID");

    const list = await client.listInvoices();
    expect(list.map((i) => i.id)).toEqual(["INV2-STUB-1"]);
  });

  it("translates a PayPal 404 into a PayPalError with status and name", async () => {
    const { client } = makeClient({ ...T0 });
    await expect(client.getInvoice("INV2-NOPE")).rejects.toMatchObject({
      status: 404,
      name_: "RESOURCE_NOT_FOUND",
    });
    await expect(client.getInvoice("INV2-NOPE")).rejects.toBeInstanceOf(PayPalError);
  });
});

describe("sandbox orders", () => {
  it("creates, captures, and lists by re-GET-ing known ids (Orders v2 has no list endpoint)", async () => {
    const { client, stub } = makeClient({ ...T0 });
    const order = await client.createOrder({
      description: "Studio cable pack",
      amount: { currency_code: "USD", value: "59.00" },
      reference_id: "pack-1",
    });
    expect(order.status).toBe("CREATED");
    const captured = await client.captureOrder(order.id);
    expect(captured.status).toBe("COMPLETED");
    expect(captured.purchase_units[0]?.payments?.captures[0]?.id).toBe("CAP-STUB-1");
    const list = await client.listOrders();
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("COMPLETED");
    const getCalls = stub.requests.filter((r) => r.method === "GET" && r.url.includes("/v2/checkout/orders/"));
    expect(getCalls).toHaveLength(1);
  });
});

describe("sandbox payouts", () => {
  it("posts a batch and maps items back with the recipient names supplied at creation", async () => {
    const { client, stub } = makeClient({ ...T0 });
    const batch = await client.createPayout({
      items: [{ recipient: MARCO, amount: { currency_code: "USD", value: "200.00" }, note: "Contractor share" }],
    });
    expect(batch.batch_header.payout_batch_id).toBe("BATCH-STUB-1");
    expect(batch.batch_header.batch_status).toBe("SUCCESS");
    expect(batch.items[0]?.transaction_status).toBe("SUCCESS");
    // PayPal's response carries only the receiver email; the name comes
    // from the recipient this client supplied at creation time.
    expect(batch.items[0]?.payout_item.recipient).toEqual(MARCO);
    expect(batch.items[0]?.payout_item.receiver).toBe("marco@example.com");
    const postReq = stub.requests.find((r) => r.method === "POST" && r.url.endsWith("/v1/payments/payouts"))!;
    const postBody = JSON.parse(postReq.body) as Record<string, any>;
    expect(postBody.items[0]).toMatchObject({ recipient_type: "EMAIL", receiver: "marco@example.com" });
    expect(postBody.sender_batch_header.sender_batch_id).toMatch(/^LEDGERPILOT-/);
  });
});

describe("sandbox read-only surfaces", () => {
  it("maps disputes and the nested Transaction Search shape, querying a 30-day window", async () => {
    const { client, stub } = makeClient({ ...T0 });
    const disputes = await client.listDisputes();
    expect(disputes).toHaveLength(1);
    expect(disputes[0]?.dispute_id).toBe("PP-D-STUB-1");
    expect(disputes[0]?.sample).toBeUndefined();
    expect(disputes[0]?.disputed_transactions[0]?.buyer.email_address).toBe("sam@example.com");

    const txns = await client.listTransactions();
    expect(txns).toHaveLength(1);
    expect(txns[0]?.transaction_id).toBe("TXN-STUB-9");
    expect(txns[0]?.transaction_amount.value).toBe("450.00");
    expect(txns[0]?.payer_info?.name).toBe("Ana Example");
    const txnReq = stub.requests.find((r) => r.url.includes("/v1/reporting/transactions"))!;
    const query = new URL(txnReq.url).searchParams;
    expect(query.get("start_date")).toBe("2026-09-10T12:00:00.000Z");
    expect(query.get("end_date")).toBe("2026-10-10T12:00:00.000Z");
  });
});

describe("sandbox webhook verification", () => {
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
  const headers = {
    "paypal-transmission-id": "transmission-1",
    "paypal-transmission-sig": "good-sig",
    "paypal-transmission-time": "2026-10-10T12:00:00Z",
    "paypal-cert-url": "https://api.sandbox.paypal.com/certs/CERT-1",
    "paypal-auth-algo": "SHA256withRSA",
  };

  it("returns true only on a SUCCESS verification status, and sends the webhook id", async () => {
    const { client, stub } = makeClient({ ...T0 });
    await expect(client.verifyWebhookSignature(headers, event)).resolves.toBe(true);
    await expect(
      client.verifyWebhookSignature({ ...headers, "paypal-transmission-sig": "bad-sig" }, event),
    ).resolves.toBe(false);
    const verifyReq = stub.requests.find((r) => r.url.endsWith("/v1/notifications/verify-webhook-signature"))!;
    expect(JSON.parse(verifyReq.body)).toMatchObject({ webhook_id: "WH-ID-1", transmission_id: "transmission-1" });
  });

  it("returns false without calling PayPal when headers are missing or no webhook id is configured", async () => {
    const { client, stub } = makeClient({ ...T0 });
    await expect(client.verifyWebhookSignature({}, event)).resolves.toBe(false);
    const noWebhook = new SandboxPayPalClient({
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      fetchFn: stub.fetchFn,
      now: () => T0.ms,
    });
    await expect(noWebhook.verifyWebhookSignature(headers, event)).resolves.toBe(false);
    expect(stub.requests.filter((r) => r.url.includes("verify-webhook-signature"))).toHaveLength(0);
  });
});
