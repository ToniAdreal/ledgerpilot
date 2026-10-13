import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  UNSUPPORTED_MEDIA_TYPE_ERROR,
  isUnsupportedJsonContentType,
  readJsonObjectBody,
  unsupportedMediaTypeResponse,
} from "../src/lib/api/body";
import {
  API_OPERATIONS,
  UNSUPPORTED_MEDIA_TYPE_RESPONSE,
  apiOperationResponses,
  buildOpenApiDocument,
} from "../src/lib/api/openapi";
import { POST as planPOST } from "../src/app/api/agent/plan/route";
import { POST as suggestPOST } from "../src/app/api/agent/suggest/route";
import { POST as webhookPOST } from "../src/app/api/paypal/webhooks/route";

/**
 * The declared media type case (HTTP 415). Every object-body POST
 * route in this app speaks JSON, but the shared reader used to parse
 * the body whatever its declared Content-Type said — a text/plain
 * or form-encoded body carrying JSON text was accepted, so the
 * contract "send JSON" was unenforced. The reader now answers the
 * shared 415 when a Content-Type header is present and not a JSON
 * media type, before reading the body; a missing header stays
 * accepted (historic behaviour for undeclared JSON). These tests
 * pin the pure check, the reader, two live handlers, the suggest
 * route's present-body application, and the OpenAPI agreement.
 */

const ROOT = join(__dirname, "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function post(url: string, rawBody: string, contentType?: string): Request {
  const headers: Record<string, string> = {};
  if (contentType !== undefined) headers["content-type"] = contentType;
  return new Request(url, { method: "POST", headers, body: rawBody });
}

describe("the media type check — pure helpers", () => {
  it("the shared error message names the required Content-Type verbatim", () => {
    expect(UNSUPPORTED_MEDIA_TYPE_ERROR).toBe(
      "Unsupported Media Type — JSON request bodies must be sent with Content-Type: application/json",
    );
  });

  it("accepts application/json, with parameters and in any casing", () => {
    expect(isUnsupportedJsonContentType("application/json")).toBe(false);
    expect(isUnsupportedJsonContentType("application/json; charset=utf-8")).toBe(false);
    expect(isUnsupportedJsonContentType("Application/JSON")).toBe(false);
  });

  it("accepts application/*+json suffix media types", () => {
    expect(isUnsupportedJsonContentType("application/vnd.api+json")).toBe(false);
    expect(isUnsupportedJsonContentType("application/ld+json; charset=utf-8")).toBe(false);
  });

  it("a missing or empty header is not unsupported — undeclared JSON is still read", () => {
    expect(isUnsupportedJsonContentType(null)).toBe(false);
    expect(isUnsupportedJsonContentType("")).toBe(false);
    expect(isUnsupportedJsonContentType("  ; charset=utf-8")).toBe(false);
  });

  it("rejects declared non-JSON media types", () => {
    expect(isUnsupportedJsonContentType("text/plain")).toBe(true);
    expect(isUnsupportedJsonContentType("text/plain; charset=utf-8")).toBe(true);
    expect(isUnsupportedJsonContentType("application/x-www-form-urlencoded")).toBe(true);
    expect(isUnsupportedJsonContentType("multipart/form-data; boundary=----x")).toBe(true);
    expect(isUnsupportedJsonContentType("application/xml")).toBe(true);
    expect(isUnsupportedJsonContentType("text/json")).toBe(true);
  });

  it("unsupportedMediaTypeResponse is a 415 whose body is exactly the shared { error } shape", async () => {
    const response = unsupportedMediaTypeResponse();
    expect(response.status).toBe(415);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["error"]);
    expect(payload.error).toBe(UNSUPPORTED_MEDIA_TYPE_ERROR);
  });
});

describe("readJsonObjectBody — the media type check runs before the body is read", () => {
  it("answers a text/plain body carrying valid JSON with the 415, not a parse", async () => {
    const result = await readJsonObjectBody(
      post("http://localhost/api/agent/plan", '{"brief":"Invoice Ana $450"}', "text/plain"),
      "Request body must be JSON",
    );
    expect(result.body).toBeNull();
    expect(result.response!.status).toBe(415);
    const payload = (await result.response!.json()) as Record<string, unknown>;
    expect(payload.error).toBe(UNSUPPORTED_MEDIA_TYPE_ERROR);
  });

  it("answers a form-encoded body with the 415", async () => {
    const result = await readJsonObjectBody(
      post("http://localhost/api/agent/plan", "brief=Invoice+Ana", "application/x-www-form-urlencoded"),
      "Request body must be JSON",
    );
    expect(result.response!.status).toBe(415);
  });

  it("still reads a JSON body declared application/json, and one with no header at all", async () => {
    const declared = await readJsonObjectBody(
      post("http://localhost/api/agent/plan", '{"brief":"x"}', "application/json; charset=utf-8"),
      "Request body must be JSON",
    );
    expect(declared.response).toBeNull();
    expect(declared.body).toEqual({ brief: "x" });
    // A truly header-less request: a byte body carries no implicit
    // Content-Type (a string body would make fetch itself declare
    // text/plain — a declaration, which the check governs).
    const undeclared = await readJsonObjectBody(
      new Request("http://localhost/api/agent/plan", {
        method: "POST",
        body: new TextEncoder().encode('{"brief":"x"}'),
      }),
      "Request body must be JSON",
    );
    expect(undeclared.response).toBeNull();
    expect(undeclared.body).toEqual({ brief: "x" });
  });
});

describe("live handlers — the 415 reaches no validator, runtime work, or PayPal call", () => {
  it("POST /api/agent/plan with a text/plain body answers 415 and drafts nothing", async () => {
    const res = await planPOST(
      post("http://localhost/api/agent/plan", '{"brief":"Invoice Ana $450 for logo work"}', "text/plain"),
    );
    expect(res.status).toBe(415);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.error).toBe(UNSUPPORTED_MEDIA_TYPE_ERROR);
  });

  it("POST /api/paypal/webhooks with a non-JSON Content-Type answers 415 before any signature work", async () => {
    const res = await webhookPOST(
      post("http://localhost/api/paypal/webhooks", '{"id":"WH-1","event_type":"INVOICING.INVOICE.PAID"}', "text/plain"),
    );
    expect(res.status).toBe(415);
  });

  it("POST /api/agent/suggest: a present body with a non-JSON Content-Type answers 415; an empty body is untouched", async () => {
    const res = await suggestPOST(
      post("http://localhost/api/agent/suggest", '{"referenceDate":"2026-10-10"}', "text/plain"),
    );
    expect(res.status).toBe(415);
    const empty = await suggestPOST(post("http://localhost/api/agent/suggest", "", "text/plain"));
    expect(empty.status).toBe(200);
  });
});

describe("OpenAPI agreement — the shared 415 lands on body-bearing operations only", () => {
  it("apiOperationResponses appends the 415 exactly where a body is taken", () => {
    for (const op of API_OPERATIONS) {
      const responses = apiOperationResponses(op);
      if (op.requestBody) {
        expect(responses["415"], op.operationId).toBe(UNSUPPORTED_MEDIA_TYPE_RESPONSE);
      } else {
        expect(responses["415"], op.operationId).toBeUndefined();
      }
    }
  });

  it("the built document carries the 415 referencing the shared Error schema", () => {
    const doc = buildOpenApiDocument() as {
      paths: Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: unknown }> }> }>>;
    };
    const plan = doc.paths["/api/agent/plan"].post;
    expect(plan.responses["415"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/Error",
    });
    const health = doc.paths["/api/health"].get;
    expect(health.responses["415"]).toBeUndefined();
  });

  it("the README documents the media type rule", () => {
    const readme = read("README.md");
    expect(readme).toContain("Content-Type enforcement (the JSON 415)");
    expect(readme).toContain("application/json");
  });
});
