import { describe, expect, it } from "vitest";
import {
  PayPalNotConfiguredError,
  SandboxPayPalClient,
  type FetchFn,
} from "@/lib/paypal";
import type { WebhookEvent } from "@/lib/types";

/**
 * Sandbox credential normalisation tests — the configured client id,
 * client secret, and webhook id are trimmed, a value that is empty
 * once trimmed counts as missing (credentials) or unconfigured
 * (webhook id), exercised against a stub fetch with FAKE credentials.
 * No network, no real account. This mirrors the health report's
 * non-blank rule: a whitespace-only credential is not set.
 */

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeStubFetch() {
  const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url, headers, body });
    const path = new URL(url).pathname;
    if (path === "/v1/oauth2/token") {
      return json(200, { access_token: "fake-token", expires_in: 3600 });
    }
    if (path === "/v2/invoicing/invoices") {
      return json(200, { items: [] });
    }
    if (path === "/v1/notifications/verify-webhook-signature") {
      return json(200, { verification_status: "SUCCESS" });
    }
    return json(404, { name: "RESOURCE_NOT_FOUND", message: `no stub route for ${path}` });
  };
  return { fetchFn, requests };
}

const HEADERS = {
  "paypal-transmission-id": "transmission-1",
  "paypal-transmission-sig": "good-sig",
  "paypal-transmission-time": "2026-10-10T12:00:00Z",
  "paypal-cert-url": "https://example.test/cert.pem",
  "paypal-auth-algo": "SHA256withRSA",
};

const EVENT = {
  id: "WH-TEST-1",
  event_type: "INVOICING.INVOICE.PAID",
  resource: {},
} as unknown as WebhookEvent;

describe("sandbox credential normalisation", () => {
  it("treats a whitespace-only client id as missing", () => {
    let caught: unknown;
    try {
      new SandboxPayPalClient({ clientId: "   ", clientSecret: "fake-client-secret" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PayPalNotConfiguredError);
    expect((caught as PayPalNotConfiguredError).missing).toEqual(["PAYPAL_CLIENT_ID"]);
  });

  it("treats a whitespace-only client secret as missing", () => {
    let caught: unknown;
    try {
      new SandboxPayPalClient({ clientId: "fake-client-id", clientSecret: " \t " });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PayPalNotConfiguredError);
    expect((caught as PayPalNotConfiguredError).missing).toEqual(["PAYPAL_CLIENT_SECRET"]);
  });

  it("names both variables when both credentials are blank", () => {
    let caught: unknown;
    try {
      new SandboxPayPalClient({ clientId: "", clientSecret: "  " });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PayPalNotConfiguredError);
    expect((caught as PayPalNotConfiguredError).missing).toEqual([
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
    ]);
  });

  it("trims padded credentials before they reach the Basic auth header", async () => {
    const { fetchFn, requests } = makeStubFetch();
    const client = new SandboxPayPalClient({
      clientId: "  fake-client-id  ",
      clientSecret: "\tfake-client-secret ",
      fetchFn,
    });
    await expect(client.listInvoices()).resolves.toEqual([]);
    const tokenReq = requests.find((r) => r.url.endsWith("/v1/oauth2/token"))!;
    expect(tokenReq.headers.Authorization).toBe(
      `Basic ${Buffer.from("fake-client-id:fake-client-secret").toString("base64")}`,
    );
  });

  it("preserves ordinary credentials exactly", async () => {
    const { fetchFn, requests } = makeStubFetch();
    const client = new SandboxPayPalClient({
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      fetchFn,
    });
    await expect(client.listInvoices()).resolves.toEqual([]);
    const tokenReq = requests.find((r) => r.url.endsWith("/v1/oauth2/token"))!;
    expect(tokenReq.headers.Authorization).toBe(
      `Basic ${Buffer.from("fake-client-id:fake-client-secret").toString("base64")}`,
    );
  });

  it("trims a padded webhook id before it reaches the verify request", async () => {
    const { fetchFn, requests } = makeStubFetch();
    const client = new SandboxPayPalClient({
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      webhookId: "  WH-ID-1  ",
      fetchFn,
    });
    await expect(client.verifyWebhookSignature(HEADERS, EVENT)).resolves.toBe(true);
    const verifyReq = requests.find((r) => r.url.endsWith("/v1/notifications/verify-webhook-signature"))!;
    expect(JSON.parse(verifyReq.body)).toMatchObject({ webhook_id: "WH-ID-1" });
  });

  it("treats a whitespace-only webhook id as unconfigured — no verify call is made", async () => {
    const { fetchFn, requests } = makeStubFetch();
    const client = new SandboxPayPalClient({
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      webhookId: "   ",
      fetchFn,
    });
    await expect(client.verifyWebhookSignature(HEADERS, EVENT)).resolves.toBe(false);
    expect(requests).toHaveLength(0);
  });
});
