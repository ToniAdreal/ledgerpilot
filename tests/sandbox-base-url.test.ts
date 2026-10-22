import { describe, expect, it } from "vitest";
import {
  SANDBOX_DEFAULT_BASE_URL,
  SandboxPayPalClient,
  type FetchFn,
} from "@/lib/paypal";

/**
 * Sandbox base-URL normalisation tests — the configured base URL is
 * trimmed and stripped of ALL trailing slashes, and a value that is
 * empty once normalised falls back to the default, exercised against
 * a stub fetch with FAKE credentials. No network, no real account.
 * The stub routes on the exact request pathname, so a double-slash
 * URL (the pre-normalisation failure) matches nothing and fails the
 * request-level test instead of silently passing.
 */

const CREDS = { clientId: "fake-client-id", clientSecret: "fake-client-secret" };

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeStubFetch() {
  const urls: string[] = [];
  const fetchFn: FetchFn = async (url) => {
    urls.push(url);
    const path = new URL(url).pathname;
    if (path === "/v1/oauth2/token") {
      return json(200, { access_token: "fake-token", expires_in: 3600 });
    }
    if (path === "/v2/invoicing/invoices") {
      return json(200, { items: [] });
    }
    return json(404, { name: "RESOURCE_NOT_FOUND", message: `no stub route for ${path}` });
  };
  return { fetchFn, urls };
}

describe("sandbox base URL normalisation", () => {
  it("names the default base URL and uses it when none is configured", () => {
    expect(SANDBOX_DEFAULT_BASE_URL).toBe("https://api-m.sandbox.paypal.com");
    const client = new SandboxPayPalClient({ ...CREDS, fetchFn: makeStubFetch().fetchFn });
    expect(client.baseUrl).toBe("https://api-m.sandbox.paypal.com");
  });

  it("strips a single trailing slash (the pre-existing behaviour)", () => {
    const client = new SandboxPayPalClient({
      ...CREDS,
      baseUrl: "https://sandbox.example/",
      fetchFn: makeStubFetch().fetchFn,
    });
    expect(client.baseUrl).toBe("https://sandbox.example");
  });

  it("strips ALL trailing slashes, not just one", () => {
    const client = new SandboxPayPalClient({
      ...CREDS,
      baseUrl: "https://sandbox.example///",
      fetchFn: makeStubFetch().fetchFn,
    });
    expect(client.baseUrl).toBe("https://sandbox.example");
  });

  it("trims surrounding whitespace before stripping slashes", () => {
    const client = new SandboxPayPalClient({
      ...CREDS,
      baseUrl: "  https://sandbox.example//  ",
      fetchFn: makeStubFetch().fetchFn,
    });
    expect(client.baseUrl).toBe("https://sandbox.example");
  });

  it("falls back to the default for a blank or slashes-only value", () => {
    for (const baseUrl of ["", "   ", "///"]) {
      const client = new SandboxPayPalClient({
        ...CREDS,
        baseUrl,
        fetchFn: makeStubFetch().fetchFn,
      });
      expect(client.baseUrl).toBe(SANDBOX_DEFAULT_BASE_URL);
    }
  });

  it("preserves an ordinary configured base URL exactly, path suffix included", () => {
    const client = new SandboxPayPalClient({
      ...CREDS,
      baseUrl: "https://sandbox.example/paypal",
      fetchFn: makeStubFetch().fetchFn,
    });
    expect(client.baseUrl).toBe("https://sandbox.example/paypal");
  });

  it("builds request URLs with exactly one slash between base and path", async () => {
    const { fetchFn, urls } = makeStubFetch();
    const client = new SandboxPayPalClient({
      ...CREDS,
      baseUrl: "https://sandbox.example///",
      fetchFn,
    });
    await expect(client.listInvoices()).resolves.toEqual([]);
    expect(urls).toEqual([
      "https://sandbox.example/v1/oauth2/token",
      "https://sandbox.example/v2/invoicing/invoices?page_size=100",
    ]);
  });
});
