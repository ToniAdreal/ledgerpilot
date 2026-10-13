import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  API_OPERATIONS,
  RATE_LIMIT_MAX_POSTS,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_WINDOW_SECONDS,
  TOO_MANY_REQUESTS_RESPONSE,
  apiOperationResponses,
  buildOpenApiDocument,
  createRateLimiter,
  describeRateLimited,
  rateLimitKeyFromHeaders,
  rateLimitResponse,
} from "../src/lib/api";

const ROOT = join(__dirname, "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function headers(init: Record<string, string> = {}): Headers {
  return new Headers(init);
}

const T0 = 1_760_000_000_000;

describe("createRateLimiter — fixed window", () => {
  it("the shipped limit is 120 POSTs per 60 seconds", () => {
    expect(RATE_LIMIT_MAX_POSTS).toBe(120);
    expect(RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(RATE_LIMIT_WINDOW_SECONDS).toBe(60);
  });

  it("allows exactly the limit, then refuses with a Retry-After inside the window", () => {
    const limiter = createRateLimiter(3, 60_000);
    expect(limiter.check("a", T0)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.check("a", T0 + 1_000).allowed).toBe(true);
    expect(limiter.check("a", T0 + 2_000).allowed).toBe(true);
    const refused = limiter.check("a", T0 + 3_000);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(57);
  });

  it("a refusal does not extend the window, and the window resets at its end", () => {
    const limiter = createRateLimiter(1, 60_000);
    expect(limiter.check("a", T0).allowed).toBe(true);
    expect(limiter.check("a", T0 + 30_000)).toEqual({
      allowed: false,
      retryAfterSeconds: 30,
    });
    expect(limiter.check("a", T0 + 59_999).allowed).toBe(false);
    expect(limiter.check("a", T0 + 60_000)).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
  });

  it("windows are per client key", () => {
    const limiter = createRateLimiter(1, 60_000);
    expect(limiter.check("a", T0).allowed).toBe(true);
    expect(limiter.check("a", T0).allowed).toBe(false);
    expect(limiter.check("b", T0).allowed).toBe(true);
  });

  it("Retry-After is at least 1 second, even a millisecond before reset", () => {
    const limiter = createRateLimiter(1, 60_000);
    limiter.check("a", T0);
    expect(limiter.check("a", T0 + 59_999).retryAfterSeconds).toBe(1);
  });
});

describe("rateLimitKeyFromHeaders — the flood-brake key", () => {
  it("uses the first x-forwarded-for entry, trimmed", () => {
    expect(
      rateLimitKeyFromHeaders(headers({ "x-forwarded-for": " 203.0.113.7 , 10.0.0.1" })),
    ).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip, then to the shared direct bucket", () => {
    expect(rateLimitKeyFromHeaders(headers({ "x-real-ip": "198.51.100.4" }))).toBe(
      "198.51.100.4",
    );
    expect(rateLimitKeyFromHeaders(headers())).toBe("direct");
    expect(rateLimitKeyFromHeaders(headers({ "x-forwarded-for": " , " }))).toBe("direct");
  });
});

describe("describeRateLimited — the JSON 429", () => {
  it("passes POSTs within the limit and refuses the one past it: 429, shared shape only, limit named", () => {
    const limiter = createRateLimiter(2, 60_000);
    expect(describeRateLimited("/api/agent/plan", "POST", headers(), limiter, T0)).toBeNull();
    expect(describeRateLimited("/api/agent/plan", "POST", headers(), limiter, T0)).toBeNull();
    const described = describeRateLimited("/api/agent/plan", "POST", headers(), limiter, T0);
    expect(described).not.toBeNull();
    expect(described!.status).toBe(429);
    expect(Object.keys(described!.body)).toEqual(["error"]);
    expect(described!.body.error).toContain("/api/agent/plan");
    // The message names the enforcing limiter's own limit (2 here);
    // the shipped default limiter's message is pinned separately below.
    expect(described!.body.error).toContain("2 POST requests per 60 seconds");
    expect(described!.retryAfterSeconds).toBeGreaterThan(0);
    expect(described!.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("the shipped default limiter's message names 120 POST requests per 60 seconds", () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < RATE_LIMIT_MAX_POSTS; i++) {
      expect(describeRateLimited("/api/agent/plan", "POST", headers(), limiter, T0)).toBeNull();
    }
    const described = describeRateLimited("/api/agent/plan", "POST", headers(), limiter, T0);
    expect(described!.body.error).toContain("120 POST requests per 60 seconds");
  });

  it("reads are never counted, whatever their volume", () => {
    const limiter = createRateLimiter(1, 60_000);
    for (let i = 0; i < 10; i++) {
      expect(describeRateLimited("/api/health", "GET", headers(), limiter, T0)).toBeNull();
      expect(describeRateLimited("/api/console/summary", "HEAD", headers(), limiter, T0)).toBeNull();
    }
    // The single POST allowance is untouched by all those reads.
    expect(describeRateLimited("/api/judge/seed", "POST", headers(), limiter, T0)).toBeNull();
    expect(describeRateLimited("/api/judge/seed", "POST", headers(), limiter, T0)).not.toBeNull();
  });

  it("method casing does not matter, and distinct forwarded clients hold distinct windows", () => {
    const limiter = createRateLimiter(1, 60_000);
    const clientA = headers({ "x-forwarded-for": "203.0.113.7" });
    const clientB = headers({ "x-forwarded-for": "203.0.113.8" });
    expect(describeRateLimited("/api/agent/plan", "post", clientA, limiter, T0)).toBeNull();
    expect(describeRateLimited("/api/agent/plan", "POST", clientA, limiter, T0)).not.toBeNull();
    expect(describeRateLimited("/api/agent/plan", "POST", clientB, limiter, T0)).toBeNull();
  });

  it("the message carries no header value, email, or credential-shaped text", () => {
    const limiter = createRateLimiter(0, 60_000);
    const described = describeRateLimited(
      "/api/agent/plan",
      "POST",
      headers({ "x-forwarded-for": "203.0.113.7" }),
      limiter,
      T0,
    );
    expect(described!.body.error).not.toContain("203.0.113.7");
    expect(described!.body.error).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(described!.body.error).not.toMatch(/PAYPAL_CLIENT_SECRET|sk-|Bearer /);
  });
});

describe("rateLimitResponse + middleware wiring", () => {
  it("returns a JSON 429 NextResponse with Retry-After, and null on pass-through", async () => {
    const limiter = createRateLimiter(1, 60_000);
    expect(
      rateLimitResponse("/api/agent/plan", "POST", headers(), limiter, T0),
    ).toBeNull();
    const response = rateLimitResponse("/api/agent/plan", "POST", headers(), limiter, T0);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(429);
    expect(response!.headers.get("retry-after")).toBe("60");
    expect(response!.headers.get("content-type")).toContain("application/json");
    const body = (await response!.json()) as { error: string };
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error).toContain("Too Many Requests");
  });

  it("the middleware runs the rate guard after the method and negotiation guards, matches /api/* only, and builds no runtime", () => {
    const source = read("src/middleware.ts");
    expect(source).toContain("rateLimitResponse");
    expect(source.indexOf("methodNotAllowedResponse(pathname")).toBeLessThan(
      source.indexOf("notAcceptableResponse(pathname"),
    );
    expect(source.indexOf("notAcceptableResponse(pathname")).toBeLessThan(
      source.indexOf("rateLimitResponse(pathname"),
    );
    expect(source).toContain('matcher: "/api/:path*"');
    expect(source).not.toContain("getAgentRuntime");
    expect(source).not.toContain("acquireRuntime");
  });
});

describe("OpenAPI agreement — the document declares the shared 429", () => {
  it("apiOperationResponses carries TOO_MANY_REQUESTS_RESPONSE on POST operations only", () => {
    for (const op of API_OPERATIONS) {
      if (op.method === "post") {
        expect(apiOperationResponses(op)["429"], op.operationId).toBe(
          TOO_MANY_REQUESTS_RESPONSE,
        );
      } else {
        expect(apiOperationResponses(op)["429"], op.operationId).toBeUndefined();
      }
    }
  });

  it("the built document carries the 429 referencing the shared Error schema on POST operations, and none on GETs", () => {
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
    const ops = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, op]) => ({ path, method, ...op })),
    );
    expect(ops.length).toBe(API_OPERATIONS.length);
    for (const op of ops) {
      if (op.method === "post") {
        expect(op.responses["429"]?.description, op.operationId).toBe(
          TOO_MANY_REQUESTS_RESPONSE,
        );
        expect(
          op.responses["429"]?.content?.["application/json"]?.schema,
          op.operationId,
        ).toEqual({ $ref: "#/components/schemas/Error" });
      } else {
        expect(op.responses["429"], op.operationId).toBeUndefined();
      }
    }
  });

  it("the README documents the JSON 429", () => {
    expect(read("README.md")).toContain("JSON 429");
    expect(read("README.md")).toContain("rate-limit");
  });
});
