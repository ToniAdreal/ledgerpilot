import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  API_OPERATIONS,
  METHOD_NOT_ALLOWED_RESPONSE,
  allowedMethodsForApiPath,
  apiOperationResponses,
  buildOpenApiDocument,
  describeMethodNotAllowed,
  methodNotAllowedResponse,
} from "../src/lib/api";

const ROOT = join(__dirname, "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("allowedMethodsForApiPath — the registry as the path→method source of truth", () => {
  it("resolves single-method and dual-method concrete paths", () => {
    expect(allowedMethodsForApiPath("/api/health")).toEqual(["GET"]);
    expect(allowedMethodsForApiPath("/api/paypal/webhooks")).toEqual(["POST"]);
    expect(allowedMethodsForApiPath("/api/agent/plan")).toEqual(["POST", "GET"]);
    expect(allowedMethodsForApiPath("/api/agent/tools")).toEqual(["GET", "POST"]);
  });

  it("matches {id} templates against exactly one non-empty segment", () => {
    expect(allowedMethodsForApiPath("/api/console/invoices/INV2-000001")).toEqual(["GET"]);
    expect(allowedMethodsForApiPath("/api/console/disputes/PP-D-1/evidence")).toEqual(["GET"]);
    expect(allowedMethodsForApiPath("/api/console/invoices/")).toBeNull();
    expect(allowedMethodsForApiPath("/api/console/invoices/a/b")).toBeNull();
    expect(allowedMethodsForApiPath("/api/console/disputes/PP-D-1")).toBeNull();
  });

  it("returns null for undocumented paths (the catch-all's JSON 404 governs those)", () => {
    expect(allowedMethodsForApiPath("/api")).toBeNull();
    expect(allowedMethodsForApiPath("/api/nope")).toBeNull();
    expect(allowedMethodsForApiPath("/api/console")).toBeNull();
    expect(allowedMethodsForApiPath("/invoices")).toBeNull();
  });

  it("covers every registered operation's path", () => {
    for (const op of API_OPERATIONS) {
      const concrete = op.path.replace("{id}", "some-id");
      expect(allowedMethodsForApiPath(concrete), op.operationId).toContain(
        op.method.toUpperCase(),
      );
    }
  });
});

describe("describeMethodNotAllowed — the JSON 405 and its pass-throughs", () => {
  it("describes a wrong-method call: 405, shared shape only, method + path + allowed named", () => {
    const described = describeMethodNotAllowed("/api/health", "POST");
    expect(described).not.toBeNull();
    expect(described!.status).toBe(405);
    expect(Object.keys(described!.body)).toEqual(["error"]);
    expect(described!.body.error).toBe(
      "Method POST is not allowed for /api/health. Allowed: GET, HEAD. See GET /api/openapi for the documented routes.",
    );
    expect(described!.allow).toEqual(["GET", "HEAD"]);
  });

  it("names every documented method for a dual-method path, with no HEAD added to a POST-only path", () => {
    const dual = describeMethodNotAllowed("/api/agent/plan", "DELETE");
    expect(dual!.allow).toEqual(["POST", "GET", "HEAD"]);
    const postOnly = describeMethodNotAllowed("/api/judge/seed", "GET");
    expect(postOnly!.allow).toEqual(["POST"]);
    expect(postOnly!.body.error).toContain("Allowed: POST.");
  });

  it("resolves template paths with the concrete id in the message", () => {
    const described = describeMethodNotAllowed("/api/console/invoices/INV2-000001", "DELETE");
    expect(described!.status).toBe(405);
    expect(described!.body.error).toContain("/api/console/invoices/INV2-000001");
    // The message carries the path only — no query string, no header value.
    expect(described!.body.error).not.toContain("?");
  });

  it("passes through documented methods (any casing), HEAD on GET paths, and OPTIONS", () => {
    expect(describeMethodNotAllowed("/api/health", "GET")).toBeNull();
    expect(describeMethodNotAllowed("/api/health", "get")).toBeNull();
    expect(describeMethodNotAllowed("/api/health", "HEAD")).toBeNull();
    expect(describeMethodNotAllowed("/api/paypal/webhooks", "POST")).toBeNull();
    expect(describeMethodNotAllowed("/api/health", "OPTIONS")).toBeNull();
    expect(describeMethodNotAllowed("/api/paypal/webhooks", "OPTIONS")).toBeNull();
    // HEAD is only framework-served where a GET handler exists.
    expect(describeMethodNotAllowed("/api/judge/seed", "HEAD")).not.toBeNull();
  });

  it("passes through undocumented paths in every method (no 405/404 confusion)", () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(describeMethodNotAllowed("/api/nope", method)).toBeNull();
    }
  });

  it("never carries a credential-shaped value or an email address", () => {
    const described = describeMethodNotAllowed("/api/agent/plan", "PUT")!;
    expect(described.body.error).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(described.body.error).not.toMatch(/PAYPAL_CLIENT_SECRET|sk-|Bearer /);
  });
});

describe("methodNotAllowedResponse + middleware wiring", () => {
  it("returns a JSON 405 NextResponse with the Allow header, and null on pass-through", async () => {
    const response = methodNotAllowedResponse("/api/health", "POST");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(405);
    expect(response!.headers.get("allow")).toBe("GET, HEAD");
    expect(response!.headers.get("content-type")).toContain("application/json");
    expect(await response!.json()).toEqual({
      error:
        "Method POST is not allowed for /api/health. Allowed: GET, HEAD. See GET /api/openapi for the documented routes.",
    });
    expect(methodNotAllowedResponse("/api/health", "GET")).toBeNull();
    expect(methodNotAllowedResponse("/api/nope", "DELETE")).toBeNull();
  });

  it("the middleware delegates to the module, matches /api/* only, and builds no runtime", () => {
    const source = read("src/middleware.ts");
    expect(source).toContain("methodNotAllowedResponse");
    expect(source).toContain('matcher: "/api/:path*"');
    expect(source).toContain("NextResponse.next()");
    expect(source).not.toContain("getAgentRuntime");
    expect(source).not.toContain("acquireRuntime");
  });
});

describe("OpenAPI agreement — the document declares the shared 405", () => {
  it("apiOperationResponses carries METHOD_NOT_ALLOWED_RESPONSE on every operation", () => {
    for (const op of API_OPERATIONS) {
      expect(apiOperationResponses(op)["405"], op.operationId).toBe(METHOD_NOT_ALLOWED_RESPONSE);
    }
  });

  it("the built document carries the 405 on every operation, referencing the shared Error schema", () => {
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
      expect(op.responses["405"]?.description, op.operationId).toBe(METHOD_NOT_ALLOWED_RESPONSE);
      expect(op.responses["405"]?.content?.["application/json"]?.schema, op.operationId).toEqual({
        $ref: "#/components/schemas/Error",
      });
    }
  });

  it("the README documents the JSON 405", () => {
    expect(read("README.md")).toContain("JSON 405");
    expect(read("README.md")).toContain("method-not-allowed");
  });
});
