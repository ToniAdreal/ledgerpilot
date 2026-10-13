import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isJsonObject, readJsonObjectBody } from "../src/lib/api/body";
import { POST as planPOST } from "../src/app/api/agent/plan/route";
import { POST as approvePOST } from "../src/app/api/agent/approve/route";
import { POST as capturePOST } from "../src/app/api/paypal/orders/capture/route";
import { POST as invoiceDraftPOST } from "../src/app/api/paypal/invoices/route";
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

/** Every route.ts under src/app/api, as repo-relative paths. */
function routeFiles(): string[] {
  const apiDir = join(ROOT, "src/app/api");
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name === "route.ts") found.push(join(dir, entry.name).slice(ROOT.length + 1));
    }
  };
  walk(apiDir);
  return found.sort();
}

/** The POST routes whose body is a required JSON object — all of them use the shared reader. */
const OBJECT_BODY_ROUTES = [
  "src/app/api/agent/approve/route.ts",
  "src/app/api/agent/edit/route.ts",
  "src/app/api/agent/execute/route.ts",
  "src/app/api/agent/plan/route.ts",
  "src/app/api/agent/tools/route.ts",
  "src/app/api/paypal/invoices/record-payment/route.ts",
  "src/app/api/paypal/invoices/route.ts",
  "src/app/api/paypal/orders/capture/route.ts",
  "src/app/api/paypal/orders/route.ts",
  "src/app/api/paypal/payouts/route.ts",
  "src/app/api/paypal/reminders/route.ts",
  "src/app/api/paypal/webhooks/route.ts",
];

describe("isJsonObject — the pure check", () => {
  it("accepts plain objects, including empty ones", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject({ planId: "plan-0001" })).toBe(true);
  });

  it("rejects null, arrays, and every scalar — the values that used to crash field dereferences", () => {
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject([{ planId: "plan-0001" }])).toBe(false);
    expect(isJsonObject("plan-0001")).toBe(false);
    expect(isJsonObject(42)).toBe(false);
    expect(isJsonObject(true)).toBe(false);
    expect(isJsonObject(undefined)).toBe(false);
  });
});

describe("readJsonObjectBody — the route-facing reader", () => {
  it("returns the parsed object body untouched", async () => {
    const result = await readJsonObjectBody(
      post("http://localhost/x", '{"brief":"Invoice Ana $450 for logo work, due Friday"}'),
      "unused",
    );
    expect(result.response).toBeNull();
    expect(result.body).toEqual({ brief: "Invoice Ana $450 for logo work, due Friday" });
  });

  it("answers malformed JSON and an empty body with the route's own 400 message in the shared { error } shape", async () => {
    for (const raw of ["{", "not json", ""]) {
      const result = await readJsonObjectBody(post("http://localhost/x", raw), "Request body must be JSON");
      expect(result.body).toBeNull();
      expect(result.response?.status).toBe(400);
      const payload = (await result.response?.json()) as Record<string, unknown>;
      expect(Object.keys(payload)).toEqual(["error"]);
      expect(payload.error).toBe("Request body must be JSON");
    }
  });

  it("answers well-formed non-object JSON with the same 400 — never a dereference crash", async () => {
    for (const raw of ["null", "[]", '"text"', "42", "true"]) {
      const result = await readJsonObjectBody(post("http://localhost/x", raw), "Request body must be JSON");
      expect(result.body, raw).toBeNull();
      expect(result.response?.status, raw).toBe(400);
    }
  });
});

describe("route completeness — every object-body POST goes through the shared reader", () => {
  it("each object-body route imports and calls readJsonObjectBody", () => {
    for (const rel of OBJECT_BODY_ROUTES) {
      const source = read(rel);
      expect(source, rel).toContain('import { readJsonObjectBody } from "@/lib/api/body";');
      expect(source, rel).toContain("readJsonObjectBody(req,");
    }
  });

  it("no API route parses a request body with a bare req.json() cast any more", () => {
    for (const rel of routeFiles()) {
      expect(read(rel), rel).not.toContain("await req.json()");
    }
  });

  it("the suggest route is the one documented exception: optional body, same object check via isJsonObject", () => {
    const source = read("src/app/api/agent/suggest/route.ts");
    expect(source).toContain('import { isJsonObject } from "@/lib/api/body";');
    expect(source).toContain("isJsonObject(parsed)");
    expect(source).toContain("Request body must be a JSON object");
  });

  it("routes that take no body never read one", () => {
    for (const rel of [
      "src/app/api/judge/seed/route.ts",
      "src/app/api/judge/pay/route.ts",
      "src/app/api/judge/reset/route.ts",
    ]) {
      const source = read(rel);
      expect(source, rel).not.toContain("readJsonObjectBody");
      expect(source, rel).not.toContain("req.json()");
    }
  });
});

describe("live handlers — non-object bodies get the documented 400, valid bodies still work", () => {
  it("POST /api/agent/plan: null, array, and malformed bodies are the route's 400, and a numeric brief is Missing 'brief'", async () => {
    for (const raw of ["null", "[]", "{"]) {
      const res = await planPOST(post("http://localhost/api/agent/plan", raw));
      expect(res.status, raw).toBe(400);
      const payload = (await res.json()) as Record<string, unknown>;
      expect(payload.error).toBe("Request body must be JSON with a 'brief' string");
    }
    const numeric = await planPOST(post("http://localhost/api/agent/plan", '{"brief":123}'));
    expect(numeric.status).toBe(400);
    expect(((await numeric.json()) as Record<string, unknown>).error).toBe("Missing 'brief'");
  });

  it("POST /api/agent/plan: a valid brief still drafts a pending-approval plan (201)", async () => {
    const res = await planPOST(
      post("http://localhost/api/agent/plan", '{"brief":"Invoice Ana $450 for logo work, due Friday"}'),
    );
    expect(res.status).toBe(201);
    const payload = (await res.json()) as { plan: { status: string } };
    expect(payload.plan.status).toBe("pending_approval");
  });

  it("POST /api/agent/approve: a null body is the route's 400, not a TypeError 500", async () => {
    const res = await approvePOST(post("http://localhost/api/agent/approve", "null"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("Request body must be JSON");
  });

  it("POST /api/paypal/orders/capture: a scalar body is the route's 400", async () => {
    const res = await capturePOST(post("http://localhost/api/paypal/orders/capture", '"ORDER-000001"'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe(
      "Request body must be JSON with an 'orderId' string",
    );
  });

  it("POST /api/paypal/invoices: a numeric body is the draft wrapper's 400; a valid object still drafts (201)", async () => {
    const bad = await invoiceDraftPOST(post("http://localhost/api/paypal/invoices", "42"));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as Record<string, unknown>).error).toBe(
      "Request body must be JSON invoice fields",
    );
    const good = await invoiceDraftPOST(
      post(
        "http://localhost/api/paypal/invoices",
        '{"recipientName":"Ana","amount":450,"description":"Logo work","dueDate":"2026-10-16"}',
      ),
    );
    expect(good.status).toBe(201);
  });

  it("POST /api/paypal/webhooks: an array body is the listener's 400, before any signature work", async () => {
    const res = await webhookPOST(post("http://localhost/api/paypal/webhooks", "[]"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe(
      "Request body must be a JSON webhook event",
    );
  });
});
