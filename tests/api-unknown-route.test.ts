import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildOpenApiDocument,
  describeUnknownApiRoute,
  unknownApiPath,
  unknownApiRouteResponse,
} from "../src/lib/api";
import * as catchAllRoute from "../src/app/api/[[...slug]]/route";

const ROOT = join(__dirname, "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("unknownApiPath — segments to the requested path", () => {
  it("maps the catch-all root to /api itself", () => {
    expect(unknownApiPath(undefined)).toBe("/api");
    expect(unknownApiPath([])).toBe("/api");
  });

  it("joins single and nested segments", () => {
    expect(unknownApiPath(["does-not-exist"])).toBe("/api/does-not-exist");
    expect(unknownApiPath(["console", "nope", "deep"])).toBe("/api/console/nope/deep");
  });
});

describe("describeUnknownApiRoute — the pure 404 description", () => {
  it("answers 404 with the shared { error } shape and no extra fields", () => {
    const described = describeUnknownApiRoute(["does-not-exist"]);
    expect(described.status).toBe(404);
    expect(Object.keys(described.body)).toEqual(["error"]);
  });

  it("names the requested path and points at the documented route map", () => {
    const described = describeUnknownApiRoute(["console", "nope"]);
    expect(described.body.error).toContain("/api/console/nope");
    expect(described.body.error).toContain("GET /api/openapi");
  });

  it("carries no credential-shaped value and no email address", () => {
    const serialized = JSON.stringify(describeUnknownApiRoute(["x"]));
    expect(serialized).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(serialized).not.toMatch(/(client_secret|api[_-]?key|password)\s*[:=]\s*["'][^"']+["']/i);
  });
});

describe("unknownApiRouteResponse — the route-facing response", () => {
  it("is a real JSON 404 response", async () => {
    const res = unknownApiRouteResponse(["does-not-exist"]);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("/api/does-not-exist");
  });
});

describe("the catch-all route file", () => {
  const rel = "src/app/api/[[...slug]]/route.ts";

  it("exists and delegates every method to the unknown-route response", () => {
    expect(existsSync(join(ROOT, rel))).toBe(true);
    const source = read(rel);
    expect(source).toContain("unknownApiRouteResponse");
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(source, method).toContain(`export const ${method} = unknown;`);
    }
  });

  it("never builds the runtime — an unknown path is unknown in every mode", () => {
    const source = read(rel);
    expect(source).not.toContain("getAgentRuntime");
    expect(source).not.toContain("acquireRuntime");
  });

  it("its handlers answer the JSON 404 when invoked directly", async () => {
    const req = new Request("http://localhost/api/does-not-exist");
    const res = await catchAllRoute.GET(req, {
      params: Promise.resolve({ slug: ["does-not-exist"] }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("/api/does-not-exist");

    const rootRes = await catchAllRoute.POST(new Request("http://localhost/api"), {
      params: Promise.resolve({ slug: undefined }),
    });
    expect(rootRes.status).toBe(404);
    const rootBody = (await rootRes.json()) as { error: string };
    expect(rootBody.error).toContain("Unknown API route: /api.");
  });
});

describe("the catch-all never enters the documented API", () => {
  it("the OpenAPI document gains no catch-all path and stays at 29 paths", () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toHaveLength(29);
    for (const path of Object.keys(doc.paths)) {
      expect(path).not.toContain("slug");
    }
  });
});
