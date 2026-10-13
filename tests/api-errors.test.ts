import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  API_OPERATIONS,
  METHOD_NOT_ALLOWED_RESPONSE,
  NON_NEGOTIABLE_OPERATION_IDS,
  NON_RUNTIME_OPERATION_IDS,
  NOT_ACCEPTABLE_RESPONSE,
  REQUEST_BODY_TOO_LARGE_RESPONSE,
  RUNTIME_NOT_CONFIGURED_RESPONSE,
  TOO_MANY_REQUESTS_RESPONSE,
  UNSUPPORTED_MEDIA_TYPE_RESPONSE,
  apiOperationResponses,
  buildOpenApiDocument,
  describePayPalNotConfigured,
  paypalNotConfiguredResponse,
} from "../src/lib/api";
import { PayPalError, PayPalNotConfiguredError } from "../src/lib/paypal";

const ROOT = join(__dirname, "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** Every route.ts under src/app/api, as repo-relative paths. */
function routeFiles(): string[] {
  const apiDir = join(ROOT, "src/app/api");
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name === "route.ts") found.push(join(dir, entry.name));
    }
  };
  walk(apiDir);
  return found.sort();
}

describe("describePayPalNotConfigured — the pure translation", () => {
  it("maps the not-configured error to 503 with the shared { error } shape only", () => {
    const err = new PayPalNotConfiguredError(["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]);
    const described = describePayPalNotConfigured(err);
    expect(described).not.toBeNull();
    expect(described?.status).toBe(503);
    expect(Object.keys(described?.body ?? {})).toEqual(["error"]);
    expect(described?.body.error).toContain("PAYPAL_CLIENT_ID");
    expect(described?.body.error).toContain("PAYPAL_CLIENT_SECRET");
    expect(described?.body.error).toContain("PAYPAL_MODE=mock");
    // The missing list rides on the error itself, for non-HTTP callers.
    expect(err.missing).toEqual(["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]);
  });

  it("returns null for any other error — unknown failures are rethrown, never dressed up", () => {
    expect(describePayPalNotConfigured(new Error("boom"))).toBeNull();
    expect(describePayPalNotConfigured(new PayPalError("nope", 404))).toBeNull();
    expect(describePayPalNotConfigured("PAYPAL_CLIENT_ID")).toBeNull();
    expect(describePayPalNotConfigured(null)).toBeNull();
    expect(describePayPalNotConfigured(undefined)).toBeNull();
  });

  it("never carries a credential value — the body names variables only", () => {
    const described = describePayPalNotConfigured(
      new PayPalNotConfiguredError(["PAYPAL_CLIENT_SECRET"]),
    );
    expect(described?.body.error).not.toMatch(/secret-value|client-secret-value/i);
  });
});

describe("paypalNotConfiguredResponse — the route-facing response", () => {
  it("builds a 503 JSON response whose body is exactly the shared error shape", async () => {
    const response = paypalNotConfiguredResponse(
      new PayPalNotConfiguredError(["PAYPAL_CLIENT_ID"]),
    );
    expect(response).not.toBeNull();
    expect(response?.status).toBe(503);
    const body = (await response?.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["error"]);
    expect(String(body.error)).toContain("PAYPAL_CLIENT_ID");
  });

  it("returns null for other errors so the caller rethrows", () => {
    expect(paypalNotConfiguredResponse(new Error("boom"))).toBeNull();
  });
});

describe("route completeness — every runtime acquisition goes through acquireRuntime", () => {
  it("no API route calls getAgentRuntime directly any more", () => {
    for (const file of routeFiles()) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("getAgentRuntime()");
    }
  });

  it("every route file that builds the runtime imports acquireRuntime, and only the three non-runtime routes do not", () => {
    const nonRuntime = [
      "src/app/api/health/route.ts",
      "src/app/api/openapi/route.ts",
      // The unknown-route catch-all never builds the runtime either:
      // an unknown path is unknown in every mode (see unknown-route.ts).
      "src/app/api/[[...slug]]/route.ts",
    ];
    let guarded = 0;
    for (const file of routeFiles()) {
      const source = readFileSync(file, "utf8");
      const rel = file.slice(ROOT.length + 1);
      // GET /api/agent/tools is the one handler-level exception: its GET
      // is a static list, its POST acquires — the file is guarded.
      if (nonRuntime.includes(rel)) {
        expect(source, rel).not.toContain("acquireRuntime");
      } else {
        expect(source, rel).toContain('import { acquireRuntime } from "@/lib/api/errors";');
        expect(source, rel).toContain("acquireRuntime()");
        guarded += 1;
      }
    }
    expect(guarded).toBe(routeFiles().length - nonRuntime.length);
  });

  it("the errors module rethrows anything it does not translate", () => {
    const source = read("src/lib/api/errors.ts");
    expect(source).toContain("throw err;");
    expect(source).toContain("PayPalNotConfiguredError");
  });
});

describe("OpenAPI consistency — the shared runtime-backed 503", () => {
  it("apiOperationResponses appends the shared 405 to every operation and the 503 to runtime-backed operations only", () => {
    for (const op of API_OPERATIONS) {
      const responses = apiOperationResponses(op);
      // The shared 405 lands on every operation (method support is a
      // property of the path; even the non-runtime operations answer
      // a wrong-method call with it).
      let expectedLength = Object.keys(op.responses).length;
      if (!("405" in op.responses)) {
        expect(responses["405"], op.operationId).toBe(METHOD_NOT_ALLOWED_RESPONSE);
        expectedLength += 1;
      }
      // The shared 406 lands on every operation except the webhook
      // listener (its machine-peer sender does not negotiate) —
      // counted here so this suite's no-extra-responses guarantee
      // covers it too.
      if (!NON_NEGOTIABLE_OPERATION_IDS.has(op.operationId) && !("406" in op.responses)) {
        expect(responses["406"], op.operationId).toBe(NOT_ACCEPTABLE_RESPONSE);
        expectedLength += 1;
      } else if (NON_NEGOTIABLE_OPERATION_IDS.has(op.operationId)) {
        expect(responses["406"], op.operationId).toBeUndefined();
      }
      // The shared 429 lands on POST operations only (reads are
      // never counted by the rate limiter) — counted here so this
      // suite's no-extra-responses guarantee covers it too.
      if (op.method === "post" && !("429" in op.responses)) {
        expect(responses["429"], op.operationId).toBe(TOO_MANY_REQUESTS_RESPONSE);
        expectedLength += 1;
      } else if (op.method !== "post") {
        expect(responses["429"], op.operationId).toBeUndefined();
      }
      // The shared 413 lands on body-bearing operations only (a GET
      // has no body to refuse) — counted here so this suite's
      // no-extra-responses guarantee covers it too.
      if (op.requestBody && !("413" in op.responses)) {
        expect(responses["413"], op.operationId).toBe(REQUEST_BODY_TOO_LARGE_RESPONSE);
        expectedLength += 1;
      } else if (!op.requestBody) {
        expect(responses["413"], op.operationId).toBeUndefined();
      }
      // The shared 415 lands on body-bearing operations only, like
      // the 413 (a GET declares no body media type to refuse).
      if (op.requestBody && !("415" in op.responses)) {
        expect(responses["415"], op.operationId).toBe(UNSUPPORTED_MEDIA_TYPE_RESPONSE);
        expectedLength += 1;
      } else if (!op.requestBody) {
        expect(responses["415"], op.operationId).toBeUndefined();
      }
      if (NON_RUNTIME_OPERATION_IDS.has(op.operationId)) {
        // No runtime-backed 503 is ever added for these three.
        if (!("503" in op.responses)) expect(responses["503"], op.operationId).toBeUndefined();
      } else if (!("503" in op.responses)) {
        expect(responses["503"], op.operationId).toBe(RUNTIME_NOT_CONFIGURED_RESPONSE);
        expectedLength += 1;
      }
      expect(Object.keys(responses).length, op.operationId).toBe(expectedLength);
    }
  });

  it("the non-runtime set is exactly the three operations that never build the runtime", () => {
    expect([...NON_RUNTIME_OPERATION_IDS].sort()).toEqual([
      "getHealth",
      "getOpenApiDocument",
      "listAgentTools",
    ]);
    for (const id of NON_RUNTIME_OPERATION_IDS) {
      expect(API_OPERATIONS.some((op) => op.operationId === id), id).toBe(true);
    }
  });

  it("the built document carries the 503 on runtime-backed operations and the health operation keeps its own", () => {
    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<string, Record<string, { operationId: string; responses: Record<string, { description: string }> }>>;
    };
    const ops = Object.values(doc.paths).flatMap((methods) => Object.values(methods));
    const byId = new Map(ops.map((op) => [op.operationId, op]));
    expect(byId.get("getConsoleSummary")?.responses["503"]?.description).toBe(
      RUNTIME_NOT_CONFIGURED_RESPONSE,
    );
    expect(byId.get("seedJudgeScenario")?.responses["503"]?.description).toBe(
      RUNTIME_NOT_CONFIGURED_RESPONSE,
    );
    expect(byId.get("receivePayPalWebhook")?.responses["503"]?.description).toBe(
      RUNTIME_NOT_CONFIGURED_RESPONSE,
    );
    // Health's own 503 is its readiness report, not the runtime translation.
    expect(byId.get("getHealth")?.responses["503"]?.description).toContain("Readiness report");
    expect(byId.get("getOpenApiDocument")?.responses["503"]).toBeUndefined();
    expect(byId.get("listAgentTools")?.responses["503"]).toBeUndefined();
  });

  it("the README documents the structured 503", () => {
    expect(read("README.md")).toContain("structured 503");
    expect(read("README.md")).toContain("acquireRuntime");
  });
});
