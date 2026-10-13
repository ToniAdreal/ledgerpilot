import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import {
  API_OPERATIONS,
  MAX_REQUEST_ID_LENGTH,
  REQUEST_ID_HEADER,
  REQUEST_ID_RESPONSE_HEADER_DESCRIPTION,
  applyRequestId,
  buildOpenApiDocument,
  generateRequestId,
  isValidRequestId,
  requestIdFromHeaders,
  resolveRequestId,
} from "../src/lib/api";

const ROOT = join(__dirname, "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

const GENERATED = "req-00000000-0000-4000-8000-000000000000";
const generate = () => GENERATED;

describe("isValidRequestId — the echo whitelist", () => {
  it("accepts uuids, slugs, and dotted/underscored ids up to the length cap", () => {
    expect(isValidRequestId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isValidRequestId("judge-run_2026.10")).toBe(true);
    expect(isValidRequestId("a")).toBe(true);
    expect(isValidRequestId("x".repeat(MAX_REQUEST_ID_LENGTH))).toBe(true);
    expect(MAX_REQUEST_ID_LENGTH).toBe(128);
  });

  it("rejects missing, empty, and over-long values", () => {
    expect(isValidRequestId(null)).toBe(false);
    expect(isValidRequestId("")).toBe(false);
    expect(isValidRequestId("x".repeat(MAX_REQUEST_ID_LENGTH + 1))).toBe(false);
  });

  it("rejects whitespace, separators, controls, and non-ASCII — nothing injectable is echoed", () => {
    expect(isValidRequestId("two words")).toBe(false);
    expect(isValidRequestId("a/b")).toBe(false);
    expect(isValidRequestId("a,b")).toBe(false);
    expect(isValidRequestId("a\r\nX-Injected: 1")).toBe(false);
    expect(isValidRequestId("a\tb")).toBe(false);
    expect(isValidRequestId("café-1")).toBe(false);
    expect(isValidRequestId("id;drop")).toBe(false);
  });
});

describe("resolveRequestId / generateRequestId", () => {
  it("echoes a valid inbound id verbatim and never calls the generator", () => {
    let calls = 0;
    const counting = () => {
      calls += 1;
      return GENERATED;
    };
    expect(resolveRequestId("judge-run_2026.10", counting)).toBe("judge-run_2026.10");
    expect(calls).toBe(0);
  });

  it("generates for a missing or invalid inbound id instead of echoing it", () => {
    expect(resolveRequestId(null, generate)).toBe(GENERATED);
    expect(resolveRequestId("", generate)).toBe(GENERATED);
    expect(resolveRequestId("two words", generate)).toBe(GENERATED);
    expect(resolveRequestId("x".repeat(500), generate)).toBe(GENERATED);
  });

  it("the default generator mints req-<uuid> ids that are themselves valid", () => {
    const id = generateRequestId();
    expect(id).toMatch(/^req-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(isValidRequestId(id)).toBe(true);
    expect(generateRequestId(() => "fixed-uuid")).toBe("req-fixed-uuid");
  });

  it("two generated ids differ (the default generator is random)", () => {
    expect(generateRequestId()).not.toBe(generateRequestId());
  });
});

describe("requestIdFromHeaders + applyRequestId", () => {
  it("reads the x-request-id header (case-insensitive) and falls back to generation", () => {
    expect(
      requestIdFromHeaders(new Headers({ "X-Request-Id": "Trace-42" }), generate),
    ).toBe("Trace-42");
    expect(requestIdFromHeaders(new Headers(), generate)).toBe(GENERATED);
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
  });

  it("stamps the id onto a response, replacing any id already present", async () => {
    const response = NextResponse.json({ ok: true });
    response.headers.set(REQUEST_ID_HEADER, "stale-id");
    const stamped = applyRequestId(response, "fresh-id");
    expect(stamped).toBe(response);
    expect(stamped.headers.get(REQUEST_ID_HEADER)).toBe("fresh-id");
    expect(await stamped.json()).toEqual({ ok: true });
  });
});

describe("middleware wiring", () => {
  it("resolves the id before the guards, stamps guard refusals and the pass-through alike, matches /api/* only, and builds no runtime", () => {
    const source = read("src/middleware.ts");
    expect(source).toContain("resolveRequestId");
    expect(source).toContain("applyRequestId");
    expect(source.indexOf("resolveRequestId(")).toBeLessThan(
      source.indexOf("methodNotAllowedResponse(pathname"),
    );
    expect(source).toContain("NextResponse.next()");
    expect(source).toContain('matcher: "/api/:path*"');
    expect(source).not.toContain("getAgentRuntime");
    expect(source).not.toContain("acquireRuntime");
  });
});

describe("OpenAPI agreement — the document declares the header on every response", () => {
  it("every operation's every response carries the X-Request-Id header declaration", () => {
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId: string;
            responses: Record<
              string,
              { headers?: Record<string, { description: string; schema: { type: string } }> }
            >;
          }
        >
      >;
    };
    let operations = 0;
    for (const methods of Object.values(doc.paths)) {
      for (const op of Object.values(methods)) {
        operations += 1;
        for (const [code, response] of Object.entries(op.responses)) {
          const header = response.headers?.["X-Request-Id"];
          expect(header, `${op.operationId} ${code}`).toBeDefined();
          expect(header!.description).toBe(REQUEST_ID_RESPONSE_HEADER_DESCRIPTION);
          expect(header!.schema).toEqual({ type: "string" });
        }
      }
    }
    expect(operations).toBe(API_OPERATIONS.length);
  });

  it("the header description names the echo rule and the generated shape, with no credential-shaped text", () => {
    expect(REQUEST_ID_RESPONSE_HEADER_DESCRIPTION).toContain("req-<uuid>");
    expect(REQUEST_ID_RESPONSE_HEADER_DESCRIPTION).toContain("correlation handle");
    expect(REQUEST_ID_RESPONSE_HEADER_DESCRIPTION).not.toMatch(
      /PAYPAL_CLIENT_SECRET|sk-|Bearer [A-Za-z0-9]/,
    );
  });

  it("the README documents the request id", () => {
    const readme = read("README.md");
    expect(readme).toContain("X-Request-Id");
    expect(readme).toContain("request-id");
  });
});
