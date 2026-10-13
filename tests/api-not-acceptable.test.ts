import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  API_OPERATIONS,
  NEGOTIATION_EXEMPT_PATHS,
  NOT_ACCEPTABLE_RESPONSE,
  apiOperationResponses,
  buildOpenApiDocument,
  describeNotAcceptable,
  isJsonAcceptable,
  notAcceptableResponse,
} from "../src/lib/api";

const ROOT = join(__dirname, "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("isJsonAcceptable — Accept parsing by specificity", () => {
  it("accepts a missing, empty, or full-wildcard header (historic behaviour)", () => {
    expect(isJsonAcceptable(null)).toBe(true);
    expect(isJsonAcceptable("")).toBe(true);
    expect(isJsonAcceptable("*/*")).toBe(true);
    expect(isJsonAcceptable("*/*;q=0.8")).toBe(true);
  });

  it("accepts application/json with parameters and any casing", () => {
    expect(isJsonAcceptable("application/json")).toBe(true);
    expect(isJsonAcceptable("Application/JSON; charset=utf-8")).toBe(true);
    expect(isJsonAcceptable("text/html, application/json;q=0.9")).toBe(true);
  });

  it("refuses a header that names only non-JSON types", () => {
    expect(isJsonAcceptable("text/html")).toBe(false);
    expect(isJsonAcceptable("text/html, application/xml")).toBe(false);
    expect(isJsonAcceptable("image/png;q=1, text/plain;q=1")).toBe(false);
  });

  it("an exact application/json;q=0 governs over a permissive wildcard", () => {
    expect(isJsonAcceptable("application/json;q=0, */*;q=1")).toBe(false);
    expect(isJsonAcceptable("application/json;q=0")).toBe(false);
    expect(isJsonAcceptable("*/*;q=0")).toBe(false);
  });

  it("a type wildcard with q > 0 rescues a refused full wildcard", () => {
    expect(isJsonAcceptable("*/*;q=0, application/*;q=0.5")).toBe(true);
    expect(isJsonAcceptable("application/*;q=0, */*;q=1")).toBe(false);
  });

  it("a +json suffix range does not claim this API's plain JSON", () => {
    expect(isJsonAcceptable("application/vnd.example+json")).toBe(false);
    expect(isJsonAcceptable("application/*+json")).toBe(false);
  });

  it("within one specificity the highest q wins, and q is clamped to [0, 1]", () => {
    expect(isJsonAcceptable("application/json;q=0, application/json;q=0.4")).toBe(true);
    expect(isJsonAcceptable("application/json;q=2")).toBe(true);
    expect(isJsonAcceptable("application/json;q=-1")).toBe(false);
  });

  it("unparseable entries are skipped, not treated as a refusal", () => {
    expect(isJsonAcceptable("garbage")).toBe(true);
    expect(isJsonAcceptable("garbage, text/html")).toBe(false);
  });
});

describe("describeNotAcceptable — the JSON 406 and its exemptions", () => {
  it("describes a non-negotiating request: 406, shared shape only, path named", () => {
    const described = describeNotAcceptable("/api/health", "GET", "text/html");
    expect(described).not.toBeNull();
    expect(described!.status).toBe(406);
    expect(Object.keys(described!.body)).toEqual(["error"]);
    expect(described!.body.error).toBe(
      "Not Acceptable — /api/health returns application/json only, and the request's Accept header does not accept it. See GET /api/openapi for the documented routes.",
    );
  });

  it("passes through requests that accept JSON or declare nothing", () => {
    expect(describeNotAcceptable("/api/health", "GET", null)).toBeNull();
    expect(describeNotAcceptable("/api/health", "GET", "*/*")).toBeNull();
    expect(describeNotAcceptable("/api/agent/plan", "POST", "application/json")).toBeNull();
  });

  it("OPTIONS passes through untouched (the framework answers it itself)", () => {
    expect(describeNotAcceptable("/api/health", "OPTIONS", "text/html")).toBeNull();
  });

  it("the PayPal webhook listener is exempt — its machine-peer sender does not negotiate", () => {
    expect(NEGOTIATION_EXEMPT_PATHS).toEqual(["/api/paypal/webhooks"]);
    expect(describeNotAcceptable("/api/paypal/webhooks", "POST", "text/html")).toBeNull();
    expect(describeNotAcceptable("/api/paypal/webhooks", "POST", "application/json;q=0")).toBeNull();
  });

  it("unknown API paths are still negotiated (the catch-all's 404 is JSON too)", () => {
    const described = describeNotAcceptable("/api/nope", "GET", "text/html");
    expect(described!.status).toBe(406);
    expect(described!.body.error).toContain("/api/nope");
  });

  it("the message carries no header value, email, or credential-shaped text", () => {
    const described = describeNotAcceptable("/api/console/summary", "GET", "text/html");
    expect(described!.body.error).not.toContain("text/html");
    expect(described!.body.error).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(described!.body.error).not.toMatch(/PAYPAL_CLIENT_SECRET|sk-|Bearer /);
  });
});

describe("notAcceptableResponse + middleware wiring", () => {
  it("returns a JSON 406 NextResponse, and null on pass-through", async () => {
    const response = notAcceptableResponse("/api/health", "GET", "text/html");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(406);
    expect(response!.headers.get("content-type")).toContain("application/json");
    expect(await response!.json()).toEqual({
      error:
        "Not Acceptable — /api/health returns application/json only, and the request's Accept header does not accept it. See GET /api/openapi for the documented routes.",
    });
    expect(notAcceptableResponse("/api/health", "GET", "*/*")).toBeNull();
  });

  it("the middleware runs negotiation after the method guard, matches /api/* only, and builds no runtime", () => {
    const source = read("src/middleware.ts");
    expect(source).toContain("notAcceptableResponse");
    expect(source.indexOf("methodNotAllowedResponse(pathname")).toBeLessThan(
      source.indexOf("notAcceptableResponse(pathname"),
    );
    expect(source).toContain('matcher: "/api/:path*"');
    expect(source).toContain("NextResponse.next()");
    expect(source).not.toContain("getAgentRuntime");
    expect(source).not.toContain("acquireRuntime");
  });
});

describe("OpenAPI agreement — the document declares the shared 406", () => {
  it("apiOperationResponses carries NOT_ACCEPTABLE_RESPONSE on every operation except the webhook listener", () => {
    for (const op of API_OPERATIONS) {
      if (op.operationId === "receivePayPalWebhook") {
        expect(apiOperationResponses(op)["406"], op.operationId).toBeUndefined();
      } else {
        expect(apiOperationResponses(op)["406"], op.operationId).toBe(NOT_ACCEPTABLE_RESPONSE);
      }
    }
  });

  it("the built document carries the 406 referencing the shared Error schema, and none on the webhook operation", () => {
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId: string;
            responses: Record<
              string,
              { description: string; content?: Record<string, { schema?: unknown }> }
            >;
          }
        >
      >;
    };
    const ops = Object.values(doc.paths).flatMap((methods) => Object.values(methods));
    expect(ops.length).toBe(API_OPERATIONS.length);
    for (const op of ops) {
      if (op.operationId === "receivePayPalWebhook") {
        expect(op.responses["406"], op.operationId).toBeUndefined();
      } else {
        expect(op.responses["406"]?.description, op.operationId).toBe(NOT_ACCEPTABLE_RESPONSE);
        expect(op.responses["406"]?.content?.["application/json"]?.schema, op.operationId).toEqual({
          $ref: "#/components/schemas/Error",
        });
      }
    }
  });

  it("the README documents the JSON 406", () => {
    expect(read("README.md")).toContain("JSON 406");
    expect(read("README.md")).toContain("not-acceptable");
  });
});
