import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JSON_BODY_TOO_LARGE_ERROR,
  MAX_JSON_BODY_BYTES,
  isOversizedJsonBody,
  jsonBodyByteLength,
  payloadTooLargeResponse,
  readJsonObjectBody,
} from "../src/lib/api/body";
import {
  API_OPERATIONS,
  REQUEST_BODY_TOO_LARGE_RESPONSE,
  apiOperationResponses,
  buildOpenApiDocument,
} from "../src/lib/api/openapi";
import { draftPayoutPlan } from "../src/lib/agent/drafts";
import { POST as planPOST } from "../src/app/api/agent/plan/route";
import { POST as suggestPOST } from "../src/app/api/agent/suggest/route";
import { POST as payoutsPOST } from "../src/app/api/paypal/payouts/route";
import { POST as webhookPOST } from "../src/app/api/paypal/webhooks/route";

const ROOT = join(__dirname, "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function post(url: string, rawBody: string): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
  });
}

/** A valid JSON object body of exactly `bytes` UTF-8 bytes (ASCII padding inside the brief). */
function objectBodyOfSize(bytes: number): string {
  const overhead = '{"brief":""}'.length;
  return `{"brief":"${"x".repeat(bytes - overhead)}"}`;
}

describe("the size limit — constants and pure helpers", () => {
  it("the limit is 128 KiB and the shared error message names it verbatim", () => {
    expect(MAX_JSON_BODY_BYTES).toBe(131_072);
    expect(JSON_BODY_TOO_LARGE_ERROR).toBe(
      "Request body is too large — JSON request bodies are limited to 131072 bytes",
    );
  });

  it("byte length is measured in UTF-8 bytes, not characters", () => {
    expect(jsonBodyByteLength("")).toBe(0);
    expect(jsonBodyByteLength("abc")).toBe(3);
    expect(jsonBodyByteLength("é")).toBe(2);
    expect(jsonBodyByteLength("币")).toBe(3);
    // A body under the limit in characters can still be over it in bytes.
    const cjk = "币".repeat(50_000);
    expect(cjk.length).toBeLessThan(MAX_JSON_BODY_BYTES);
    expect(jsonBodyByteLength(cjk)).toBeGreaterThan(MAX_JSON_BODY_BYTES);
  });

  it("exactly at the limit is accepted; one byte over is oversized", () => {
    expect(isOversizedJsonBody(0)).toBe(false);
    expect(isOversizedJsonBody(MAX_JSON_BODY_BYTES)).toBe(false);
    expect(isOversizedJsonBody(MAX_JSON_BODY_BYTES + 1)).toBe(true);
  });

  it("payloadTooLargeResponse is a 413 whose body is exactly the shared { error } shape", async () => {
    const response = payloadTooLargeResponse();
    expect(response.status).toBe(413);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["error"]);
    expect(payload.error).toBe(JSON_BODY_TOO_LARGE_ERROR);
  });
});

describe("readJsonObjectBody — the size check runs before parsing", () => {
  it("answers an oversized valid object body with the 413, not a parse or a route 400", async () => {
    const result = await readJsonObjectBody(
      post("http://localhost/x", objectBodyOfSize(MAX_JSON_BODY_BYTES + 1)),
      "Request body must be JSON",
    );
    expect(result.body).toBeNull();
    expect(result.response?.status).toBe(413);
    const payload = (await result.response?.json()) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["error"]);
    expect(payload.error).toBe(JSON_BODY_TOO_LARGE_ERROR);
  });

  it("answers an oversized malformed body with the 413 too — size is judged before syntax", async () => {
    const result = await readJsonObjectBody(
      post("http://localhost/x", "x".repeat(MAX_JSON_BODY_BYTES + 1)),
      "Request body must be JSON",
    );
    expect(result.body).toBeNull();
    expect(result.response?.status).toBe(413);
  });

  it("accepts a body of exactly the limit and rejects one byte more", async () => {
    const atLimit = await readJsonObjectBody(
      post("http://localhost/x", objectBodyOfSize(MAX_JSON_BODY_BYTES)),
      "unused",
    );
    expect(atLimit.response).toBeNull();
    expect(atLimit.body).not.toBeNull();
    const overLimit = await readJsonObjectBody(
      post("http://localhost/x", objectBodyOfSize(MAX_JSON_BODY_BYTES + 1)),
      "unused",
    );
    expect(overLimit.body).toBeNull();
    expect(overLimit.response?.status).toBe(413);
  });
});

describe("the limit never rejects a legitimate body", () => {
  // The largest legitimate body this API accepts: a maximum-size
  // payout batch draft — 25 lines (MAX_PAYOUT_BATCH_ITEMS), every
  // text field at the drafts' own 500-char cap.
  const maxBatchBody = JSON.stringify({
    items: Array.from({ length: 25 }, (_, i) => ({
      recipientName: `Recipient ${i} ${"N".repeat(480)}`,
      recipientEmail: `recipient${i}@example.com`,
      amount: 100,
      currency: "EUR",
      note: "N".repeat(500),
    })),
    note: "B".repeat(500),
  });

  it("a maximum-size payout batch body is far under the limit and drafts successfully", async () => {
    expect(jsonBodyByteLength(maxBatchBody)).toBeLessThan(MAX_JSON_BODY_BYTES);
    const parsed = JSON.parse(maxBatchBody) as Parameters<typeof draftPayoutPlan>[0];
    expect(draftPayoutPlan(parsed).status).toBe("pending_approval");
    const res = await payoutsPOST(post("http://localhost/api/paypal/payouts", maxBatchBody));
    expect(res.status).toBe(201);
  });
});

describe("live handlers — oversized bodies get the 413, ordinary bodies still work", () => {
  it("POST /api/agent/plan: an oversized brief body is a 413, before the parser or any drafting", async () => {
    const res = await planPOST(post("http://localhost/api/agent/plan", objectBodyOfSize(MAX_JSON_BODY_BYTES + 1)));
    expect(res.status).toBe(413);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["error"]);
    expect(payload.error).toBe(JSON_BODY_TOO_LARGE_ERROR);
  });

  it("POST /api/agent/suggest: the optional body carries the same limit, checked on the raw text", async () => {
    const oversized = `{"referenceDate":"2026-10-10","pad":"${"x".repeat(MAX_JSON_BODY_BYTES)}"}`;
    const res = await suggestPOST(post("http://localhost/api/agent/suggest", oversized));
    expect(res.status).toBe(413);
    expect(((await res.json()) as Record<string, unknown>).error).toBe(JSON_BODY_TOO_LARGE_ERROR);
    const empty = await suggestPOST(post("http://localhost/api/agent/suggest", ""));
    expect(empty.status).toBe(200);
  });

  it("POST /api/paypal/webhooks: an oversized event is a 413, before any signature work", async () => {
    const oversized = `{"id":"WH-TEST","event_type":"INVOICING.INVOICE.PAID","pad":"${"x".repeat(MAX_JSON_BODY_BYTES)}"}`;
    const res = await webhookPOST(post("http://localhost/api/paypal/webhooks", oversized));
    expect(res.status).toBe(413);
    expect(((await res.json()) as Record<string, unknown>).error).toBe(JSON_BODY_TOO_LARGE_ERROR);
  });
});

describe("the suggest route applies the shared limit to its raw text", () => {
  it("its source checks the byte length and returns the shared 413 response", () => {
    const source = read("src/app/api/agent/suggest/route.ts");
    expect(source).toContain("isOversizedJsonBody(jsonBodyByteLength(text))");
    expect(source).toContain("payloadTooLargeResponse()");
  });
});

describe("OpenAPI agreement — the document declares the shared 413", () => {
  it("apiOperationResponses carries the 413 on body-bearing operations only", () => {
    for (const op of API_OPERATIONS) {
      const responses = apiOperationResponses(op);
      if (op.requestBody) {
        expect(responses["413"], op.operationId).toBe(REQUEST_BODY_TOO_LARGE_RESPONSE);
      } else {
        expect(responses["413"], op.operationId).toBeUndefined();
      }
    }
  });

  it("the built document carries the 413 on a body operation, referencing the shared Error schema, and none on a GET", () => {
    const doc = buildOpenApiDocument() as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }> }>
      >;
    };
    const plan = doc.paths["/api/agent/plan"]?.post;
    expect(plan?.responses["413"]?.description).toBe(REQUEST_BODY_TOO_LARGE_RESPONSE);
    expect(plan?.responses["413"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/Error",
    });
    expect(doc.paths["/api/health"]?.get?.responses["413"]).toBeUndefined();
    expect(doc.paths["/api/console/summary"]?.get?.responses["413"]).toBeUndefined();
  });

  it("the README documents the JSON 413", () => {
    expect(read("README.md")).toContain("JSON 413");
  });
});
