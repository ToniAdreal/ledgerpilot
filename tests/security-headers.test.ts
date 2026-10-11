import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * HTTP security headers are part of the security model SECURITY.md
 * states: a money-shaped app whose hosted demo is the judges' primary
 * path must not serve its console with no clickjacking, MIME-sniffing,
 * or referrer protections. The headers live in `next.config.mjs`
 * (Next.js config cannot import the TypeScript lib), so — in the same
 * discipline as the CI workflow and deployment descriptor — these
 * tests pin the config's shape, and the run's HTTP smoke test verifies
 * the headers actually arrive on live responses.
 */

const root = resolve(__dirname, "..");
const config = readFileSync(resolve(root, "next.config.mjs"), "utf8");
const security = readFileSync(resolve(root, "SECURITY.md"), "utf8");
const readme = readFileSync(resolve(root, "README.md"), "utf8");

describe("security headers (next.config.mjs)", () => {
  it("applies one header set to every route and hides the framework header", () => {
    expect(config).toContain("async headers()");
    expect(config).toContain('source: "/:path*"');
    expect(config).toContain("poweredByHeader: false");
  });

  it("sets the baseline transport, sniffing, framing, and referrer headers", () => {
    expect(config).toContain(
      'key: "Strict-Transport-Security"',
    );
    expect(config).toContain("max-age=31536000; includeSubDomains");
    expect(config).toContain('key: "X-Content-Type-Options"');
    expect(config).toContain('value: "nosniff"');
    expect(config).toContain('key: "X-Frame-Options"');
    expect(config).toContain('value: "DENY"');
    expect(config).toContain('key: "Referrer-Policy"');
    expect(config).toContain('value: "strict-origin-when-cross-origin"');
  });

  it("disables device features the app never uses", () => {
    expect(config).toContain('key: "Permissions-Policy"');
    expect(config).toContain("camera=(), microphone=(), geolocation=()");
  });

  it("keeps the CSP same-origin: no wildcard, no external origin", () => {
    expect(config).toContain('key: "Content-Security-Policy"');
    for (const directive of [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
    ]) {
      expect(config, directive).toContain(directive);
    }
    // No bare wildcard source and no http(s) origin is ever allowed:
    // assets are bundled and PayPal / LLM traffic is server-side.
    expect(config).not.toMatch(/https?:\/\//);
    expect(config).not.toContain("src *");
    expect(config).not.toContain("'unsafe-inline' *");
  });

  it("allows inline scripts/styles (App Router bootstrap + inline styles) but nothing more in production", () => {
    expect(config).toContain("style-src 'self' 'unsafe-inline'");
    expect(config).toContain(
      `: "'self' 'unsafe-inline'";`,
    );
  });

  it("scopes 'unsafe-eval' and the HMR socket to development only", () => {
    expect(config).toContain(
      'process.env.NODE_ENV === "development"',
    );
    // 'unsafe-eval' appears exactly once — inside the dev branch.
    expect(config.split("'unsafe-eval'").length - 1).toBe(1);
    expect(config).toContain(
      `? "'self' 'unsafe-inline' 'unsafe-eval'"`,
    );
    expect(config.split("ws: wss:").length - 1).toBe(1);
    expect(config).toContain(`? "'self' ws: wss:" : "'self'"`);
  });

  it("does not claim HSTS preload (an irreversible host decision)", () => {
    expect(config).not.toContain("includeSubDomains; preload");
    expect(config).not.toContain('value: "max-age=31536000; includeSubDomains; preload"');
  });

  it("is documented in SECURITY.md's security model and the README", () => {
    expect(security).toContain("HTTP security headers");
    expect(security).toContain("Content-Security-Policy");
    expect(security.toLowerCase()).toContain("frame-ancestors");
    expect(readme).toContain("security headers");
  });
});
