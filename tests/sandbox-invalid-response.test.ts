import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PayPalError, SandboxPayPalClient, type FetchFn } from "@/lib/paypal";
import type { WebhookEvent } from "@/lib/types";

/**
 * Sandbox invalid success response tests — every PayPal success
 * body is JSON, and every endpoint this adapter calls answers
 * with a JSON object. A success body that is not valid JSON, or
 * that parses to a scalar / array / null instead of an object,
 * is refused at the adapter's one body-read point (`readBody`)
 * with a `PayPalError` of status 502 and name `INVALID_RESPONSE`
 * naming the request (method + path) only, never any of the body.
 * Until this check existed, `readBody` mapped any unparseable
 * body to `{ message: text }` on success statuses too, silently
 * turning a 200 HTML page into an empty-ish resource — a list
 * came back empty, a fetched resource carried empty fields, and
 * the failure was indistinguishable from "PayPal has nothing".
 * Error responses keep their exact previous mapping, JSON or
 * not, and the empty success bodies PayPal legitimately returns
 * (send-invoice 202, remind 204) are unaffected. Exercised
 * against stub fetches with FAKE credentials. No network, no
 * real PayPal account.
 */

const MARKER = "SECRET-MARKER-body-detail";
const ANA = { name: "Ana Example", email_address: "ana@example.com" };

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html" },
  });
}

function tokenJson(): Response {
  return json(200, { access_token: "fake-token", expires_in: 3600 });
}

/** Token answers with a valid object; every API path answers `apiResponse`. */
function tokenThenApiFetch(seen: string[], apiResponse: () => Response): FetchFn {
  return (url) => {
    seen.push(url);
    if (new URL(url).pathname === "/v1/oauth2/token") return Promise.resolve(tokenJson());
    return Promise.resolve(apiResponse());
  };
}

function makeClient(fetchFn: FetchFn, extra: { webhookId?: string } = {}): SandboxPayPalClient {
  return new SandboxPayPalClient({
    clientId: "fake-client-id",
    clientSecret: "fake-client-secret",
    fetchFn,
    ...(extra.webhookId !== undefined ? { webhookId: extra.webhookId } : {}),
  });
}

function expectInvalidResponse(err: unknown, label: string, kind: "not valid JSON" | "not a JSON object"): void {
  expect(err).toBeInstanceOf(PayPalError);
  const paypalErr = err as PayPalError;
  expect(paypalErr.status).toBe(502);
  expect(paypalErr.name_).toBe("INVALID_RESPONSE");
  expect(paypalErr.message).toContain(kind);
  expect(paypalErr.message).toContain(label);
  // The body itself is never carried — it can be an arbitrary
  // proxy/WAF page embedding anything.
  expect(paypalErr.message).not.toContain(MARKER);
  expect(paypalErr.message).not.toContain("fake-client-secret");
}

describe("sandbox invalid success response", () => {
  it("refuses a non-JSON success body on an API read, naming method and path", async () => {
    const seen: string[] = [];
    const client = makeClient(tokenThenApiFetch(seen, () => text(200, `<html>${MARKER}</html>`)));
    const err = await client.listDisputes().catch((e: unknown) => e);
    expectInvalidResponse(err, "GET /v1/customer/disputes", "not valid JSON");
    expect(seen).toHaveLength(2);
  });

  it("refuses a non-JSON OAuth token body and attempts no API call", async () => {
    const seen: string[] = [];
    const fetchFn: FetchFn = (url) => {
      seen.push(url);
      return Promise.resolve(text(200, `<html>${MARKER}</html>`));
    };
    const client = makeClient(fetchFn);
    const err = await client.listDisputes().catch((e: unknown) => e);
    expectInvalidResponse(err, "POST /v1/oauth2/token", "not valid JSON");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/v1/oauth2/token");
  });

  it("refuses success bodies that parse to a scalar, null, or an array", async () => {
    for (const body of ["42", `"a string"`, "true", "null", "[]", `[{"id":"X-1"}]`]) {
      const seen: string[] = [];
      const client = makeClient(
        tokenThenApiFetch(seen, () => new Response(body, { status: 200, headers: { "content-type": "application/json" } })),
      );
      const err = await client.listDisputes().catch((e: unknown) => e);
      expectInvalidResponse(err, "GET /v1/customer/disputes", "not a JSON object");
    }
  });

  it("refuses a non-JSON success body on webhook-signature verification instead of answering false", async () => {
    const seen: string[] = [];
    const client = makeClient(tokenThenApiFetch(seen, () => text(200, `<html>${MARKER}</html>`)), {
      webhookId: "WH-FAKE-ID",
    });
    const event: WebhookEvent = {
      id: "WH-INVALID-1",
      create_time: "2026-10-10T12:00:00Z",
      resource_type: "capture",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      summary: "Payment capture completed",
      resource: { id: "CAP-1" },
      event_version: "1.0",
      resource_version: "2.0",
    };
    const headers = {
      "paypal-transmission-id": "trans-invalid-1",
      "paypal-transmission-sig": "sig",
      "paypal-transmission-time": "2026-10-10T12:00:00Z",
      "paypal-cert-url": "https://api.sandbox.paypal.com/certs/fake.pem",
      "paypal-auth-algo": "SHA256withRSA",
    };
    const err = await client.verifyWebhookSignature(headers, event).catch((e: unknown) => e);
    expectInvalidResponse(err, "POST /v1/notifications/verify-webhook-signature", "not valid JSON");
  });

  it("keeps the lenient mapping for a non-JSON ERROR body (its text still reaches the error)", async () => {
    const seen: string[] = [];
    const client = makeClient(tokenThenApiFetch(seen, () => text(404, `Invoice not found upstream: ${MARKER}`)));
    const err = await client.getInvoice("INV2-NOPE").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    const paypalErr = err as PayPalError;
    expect(paypalErr.status).toBe(404);
    expect(paypalErr.name_).not.toBe("INVALID_RESPONSE");
    expect(paypalErr.name_).toBe("PAYPAL_ERROR");
    expect(paypalErr.message).toContain(MARKER);
  });

  it("keeps the structured mapping for a JSON error body", async () => {
    const seen: string[] = [];
    const client = makeClient(
      tokenThenApiFetch(seen, () => json(404, { name: "RESOURCE_NOT_FOUND", message: "Invoice not found." })),
    );
    const err = await client.getInvoice("INV2-NOPE").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    const paypalErr = err as PayPalError;
    expect(paypalErr.status).toBe(404);
    expect(paypalErr.name_).toBe("RESOURCE_NOT_FOUND");
    expect(paypalErr.message).toBe("Invoice not found.");
  });

  it("keeps a JSON scalar ERROR body on the previous path (fallback error, never INVALID_RESPONSE)", async () => {
    const seen: string[] = [];
    const client = makeClient(
      tokenThenApiFetch(seen, () => new Response("42", { status: 500, headers: { "content-type": "application/json" } })),
    );
    const err = await client.getInvoice("INV2-NOPE").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    const paypalErr = err as PayPalError;
    expect(paypalErr.status).toBe(500);
    expect(paypalErr.name_).not.toBe("INVALID_RESPONSE");
  });

  it("leaves the empty success bodies PayPal legitimately returns unaffected (send 202, remind 204)", async () => {
    const invoice = {
      id: "INV2-STUB-1",
      status: "SENT",
      detail: { currency_code: "USD" },
      invoicer: { name: { given_name: "Demo", surname: "Seller" }, email_address: "seller@example.com" },
      primary_recipients: [{ billing_info: ANA }],
      items: [{ name: "Logo work", quantity: "1", unit_amount: { currency_code: "USD", value: "450.00" } }],
      amount: { currency_code: "USD", value: "450.00" },
      due_amount: { currency_code: "USD", value: "450.00" },
      links: [],
    };
    const fetchFn: FetchFn = (url, init) => {
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      if (path === "/v1/oauth2/token") return Promise.resolve(tokenJson());
      if (path.endsWith("/send") && method === "POST") return Promise.resolve(new Response(null, { status: 202 }));
      if (path.endsWith("/remind") && method === "POST") return Promise.resolve(new Response(null, { status: 204 }));
      if (path === "/v2/invoicing/invoices/INV2-STUB-1" && method === "GET") return Promise.resolve(json(200, invoice));
      return Promise.resolve(json(404, { name: "NOT_FOUND", message: `no route ${method} ${path}` }));
    };
    const client = makeClient(fetchFn);
    const sent = await client.sendInvoice("INV2-STUB-1");
    expect(sent.id).toBe("INV2-STUB-1");
    expect(sent.status).toBe("SENT");
    const reminded = await client.sendInvoiceReminder("INV2-STUB-1");
    expect(reminded.id).toBe("INV2-STUB-1");
  });

  it("is documented in the README", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("INVALID_RESPONSE");
  });
});
