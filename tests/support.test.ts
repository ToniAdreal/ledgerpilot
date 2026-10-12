import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SUPPORT.md completes the GitHub community-health profile: GitHub
 * links it from the new-issue flow, and it is the one place that
 * says which door each kind of request uses. These tests pin the
 * routing (bugs and features to the issue forms, vulnerabilities
 * and conduct privately, never publicly) and the honesty rules —
 * best-effort with no SLA, and no invented support contact.
 */

const root = resolve(__dirname, "..");
const supportPath = resolve(root, "SUPPORT.md");
const support = existsSync(supportPath)
  ? readFileSync(supportPath, "utf8")
  : "";

describe("SUPPORT.md", () => {
  it("exists at the repo root", () => {
    expect(existsSync(supportPath)).toBe(true);
    expect(support.length).toBeGreaterThan(1000);
  });

  it("states best-effort support with no SLA and no invented contact channel", () => {
    expect(support.toLowerCase()).toContain("best-effort");
    expect(support.toLowerCase()).toContain("no support sla");
    expect(support.toLowerCase().replace(/\s+/g, " ")).toContain(
      "no support email",
    );
  });

  it("routes bugs to the bug report form and features to the feature request form", () => {
    expect(support.toLowerCase()).toContain("bug report");
    expect(support.toLowerCase()).toContain("feature request");
    expect(support).toContain("Issues → New issue");
  });

  it("sends users to the health check and Judge Mode before asking", () => {
    expect(support).toContain("GET /api/health");
    expect(support.toLowerCase()).toContain("booleans");
    expect(support).toContain("/judge");
  });

  it("keeps vulnerabilities out of public support and routes them privately per SECURITY.md", () => {
    expect(support.toLowerCase()).toContain(
      "do not open a public issue for a vulnerability",
    );
    expect(support).toContain("SECURITY.md");
    expect(support.toLowerCase()).toContain("privately through github");
  });

  it("routes conduct concerns privately per CODE_OF_CONDUCT.md", () => {
    expect(support).toContain("CODE_OF_CONDUCT.md");
    expect(support.toLowerCase().replace(/\s+/g, " ")).toContain(
      "never in a public issue",
    );
  });

  it("sets scope honestly: no PayPal account access, no real-money mode, latest default branch only", () => {
    expect(support.toLowerCase()).toContain("no real-money mode");
    expect(support.toLowerCase()).toContain(
      "latest state of the default branch",
    );
    expect(support.toLowerCase()).toContain("your own paypal developer");
  });

  it("invents no contact email address and carries no credential-shaped values", () => {
    expect(support).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(support).not.toMatch(/CLIENT_SECRET\s*=\s*\S+/);
    expect(support).not.toContain("BEGIN");
  });

  it("is referenced from the README", () => {
    const readme = readFileSync(resolve(root, "README.md"), "utf8");
    expect(readme).toContain("SUPPORT.md");
  });
});
