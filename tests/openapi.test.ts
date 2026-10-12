import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { API_OPERATIONS, API_TAGS, buildOpenApiDocument } from "../src/lib/api";

const ROOT = join(__dirname, "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

type Doc = {
  openapi: string;
  info: { title: string; version: string; description: string; license?: { identifier?: string } };
  servers: Array<{ url: string }>;
  tags: Array<{ name: string }>;
  paths: Record<string, Record<string, Op>>;
  components: { schemas: Record<string, unknown> };
};
type Op = {
  operationId: string;
  tags: string[];
  summary: string;
  description: string;
  security: unknown[];
  responses: Record<string, { description: string; content?: Record<string, { schema?: Record<string, unknown> }> }>;
  parameters?: Array<{ name: string; in: string; required: boolean }>;
  requestBody?: { required: boolean; content: Record<string, { schema: Record<string, unknown> }> };
};

function doc(): Doc {
  return buildOpenApiDocument() as unknown as Doc;
}

function allOps(d: Doc): Array<Op & { path: string; method: string }> {
  const out: Array<Op & { path: string; method: string }> = [];
  for (const [path, methods] of Object.entries(d.paths)) {
    for (const [method, op] of Object.entries(methods)) out.push({ ...op, path, method });
  }
  return out;
}

/** Walk src/app/api for route.ts files and read their exported HTTP methods from disk. */
function diskOperations(): Array<{ path: string; method: string }> {
  const apiDir = join(ROOT, "src/app/api");
  const found: Array<{ path: string; method: string }> = [];
  const walk = (dir: string, segments: string[]): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), [...segments, entry.name]);
      else if (entry.name === "route.ts") {
        const source = readFileSync(join(dir, entry.name), "utf8");
        const urlPath =
          "/api" +
          (segments.length ? "/" + segments.map((s) => s.replace(/^\[(.+)\]$/, "{$1}")).join("/") : "");
        for (const m of source.matchAll(/export async function (GET|POST)\b/g)) {
          found.push({ path: urlPath, method: m[1].toLowerCase() });
        }
      }
    }
  };
  walk(apiDir, []);
  return found.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

describe("OpenAPI document — shape", () => {
  it("is OpenAPI 3.1 for the LedgerPilot API, versioned with the package, MIT-identified", () => {
    const d = doc();
    expect(d.openapi).toBe("3.1.0");
    expect(d.info.title).toBe("LedgerPilot API");
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(d.info.version).toBe(pkg.version);
    expect(d.info.license?.identifier).toBe("MIT");
    expect(d.info.description).toContain("no real money");
    expect(d.info.description).toContain("no authentication layer");
    expect(d.info.description).toContain("access controls");
  });

  it("declares exactly one relative server — no host URL is invented", () => {
    const d = doc();
    expect(d.servers).toHaveLength(1);
    expect(d.servers[0].url).toBe("/");
    const serialized = JSON.stringify(d);
    expect(serialized).not.toMatch(/https?:\/\//);
  });

  it("returns a fresh deep copy per call (callers cannot mutate the registry document)", () => {
    const first = doc();
    first.paths["/api/health"] = {};
    first.info.title = "mutated";
    const second = doc();
    expect(second.info.title).toBe("LedgerPilot API");
    expect(second.paths["/api/health"].get.operationId).toBe("getHealth");
  });

  it("carries no credential-shaped value and no email address", () => {
    const serialized = JSON.stringify(doc());
    expect(serialized).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(serialized).not.toMatch(/(client_secret|api[_-]?key|password)\s*[:=]\s*["'][^"']+["']/i);
  });
});

describe("OpenAPI document — completeness against the routes on disk", () => {
  it("documents exactly the operations the route files export — no more, no fewer", () => {
    const fromDoc = allOps(doc())
      .map((o) => ({ path: o.path, method: o.method }))
      .sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
    expect(fromDoc).toEqual(diskOperations());
    expect(fromDoc.length).toBeGreaterThanOrEqual(29);
    expect(Object.keys(doc().paths)).toHaveLength(27);
  });

  it("the registry and the document agree (one registry entry per documented operation)", () => {
    expect(API_OPERATIONS).toHaveLength(allOps(doc()).length);
    const ids = API_OPERATIONS.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every operation has a unique operationId, a declared tag, and substantive summary + description", () => {
    const d = doc();
    const declaredTags = new Set(d.tags.map((t) => t.name));
    expect(declaredTags).toEqual(new Set(API_TAGS.map((t) => t.name)));
    const ids = new Set<string>();
    for (const op of allOps(d)) {
      expect(ids.has(op.operationId)).toBe(false);
      ids.add(op.operationId);
      expect(op.tags).toHaveLength(1);
      expect(declaredTags.has(op.tags[0])).toBe(true);
      expect(op.summary.length).toBeGreaterThan(10);
      expect(op.description.length).toBeGreaterThan(40);
    }
  });

  it("every operation declares security: [] (no auth is claimed) and at least one 2xx response", () => {
    for (const op of allOps(doc())) {
      expect(op.security).toEqual([]);
      expect(Object.keys(op.responses).some((c) => c.startsWith("2"))).toBe(true);
      for (const r of Object.values(op.responses)) expect(r.description.length).toBeGreaterThan(5);
    }
  });

  it("every error response references the shared Error schema, which requires an error string", () => {
    const d = doc();
    const errorSchema = d.components.schemas.Error as {
      required: string[];
      properties: Record<string, { type: string }>;
    };
    expect(errorSchema.required).toEqual(["error"]);
    expect(errorSchema.properties.error.type).toBe("string");
    for (const op of allOps(d)) {
      for (const [code, response] of Object.entries(op.responses)) {
        if (code.startsWith("2")) continue;
        expect(response.content?.["application/json"]?.schema).toEqual({
          $ref: "#/components/schemas/Error",
        });
      }
    }
  });

  it("path-parameter operations declare the id parameter; all others declare none", () => {
    for (const op of allOps(doc())) {
      if (op.path.includes("{id}")) {
        expect(op.parameters).toEqual([
          expect.objectContaining({ name: "id", in: "path", required: true }),
        ]);
      } else {
        expect(op.parameters).toBeUndefined();
      }
    }
  });

  it("request bodies: the body-bearing POSTs declare one; the no-body Judge POSTs declare none", () => {
    const d = doc();
    const noBody = ["/api/judge/seed", "/api/judge/pay", "/api/judge/reset"];
    for (const op of allOps(d)) {
      if (op.method !== "post") expect(op.requestBody).toBeUndefined();
      else if (noBody.includes(op.path)) expect(op.requestBody).toBeUndefined();
      else {
        expect(op.requestBody?.required).toBe(true);
        expect(op.requestBody?.content["application/json"]).toBeDefined();
      }
    }
    const webhook = d.paths["/api/paypal/webhooks"].post;
    const schema = webhook.requestBody?.content["application/json"]?.schema as unknown as {
      required: string[];
    };
    expect(schema.required).toEqual(["id", "event_type"]);
  });

  it("the draft surfaces state the approval gate in their descriptions", () => {
    const d = doc();
    for (const path of [
      "/api/paypal/invoices",
      "/api/paypal/orders",
      "/api/paypal/payouts",
      "/api/paypal/reminders",
      "/api/agent/tools",
      "/api/agent/plan",
    ]) {
      expect(d.paths[path].post.description).toContain("pending_approval");
      expect(d.paths[path].post.description).toContain("approval gate");
    }
    // …while the receiving-money legs state why they are NOT gated.
    expect(d.paths["/api/paypal/orders/capture"].post.description).toContain("needs no plan approval");
    expect(d.paths["/api/paypal/invoices/record-payment"].post.description).toContain("needs no plan approval");
  });

  it("the route file exists and serves the built document", () => {
    expect(existsSync(join(ROOT, "src/app/api/openapi/route.ts"))).toBe(true);
    const route = read("src/app/api/openapi/route.ts");
    expect(route).toContain("buildOpenApiDocument");
    expect(route).toContain("export async function GET");
  });

  it("the README documents the OpenAPI surface", () => {
    const readme = read("README.md");
    expect(readme).toContain("/api/openapi");
    expect(readme).toContain("OpenAPI");
  });
});
