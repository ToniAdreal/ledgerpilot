import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The publish-day smoke script is the automated form of the manual
 * curl loop every build round used to run by hand: health → reset →
 * seed → approve → execute → pay → summary, asserting the README's
 * exact post-loop totals. Its shape is pinned here so the publish
 * gate cannot silently lose a step, drift from the totals the README
 * promises, or grow a credential dependency — the loop it verifies
 * is the credential-free mock Judge Mode path by design.
 */

const appRoot = resolve(__dirname, "..");
const scriptPath = resolve(appRoot, "scripts/smoke.mjs");
const script = readFileSync(scriptPath, "utf8");
const packageJson = JSON.parse(
  readFileSync(resolve(appRoot, "package.json"), "utf8"),
) as { scripts: Record<string, string> };
const readme = readFileSync(resolve(appRoot, "README.md"), "utf8");

describe("publish-day smoke script (scripts/smoke.mjs)", () => {
  it("exists and is wired as the package's smoke command", () => {
    expect(existsSync(scriptPath)).toBe(true);
    expect(packageJson.scripts.smoke).toBe("node scripts/smoke.mjs");
    expect(script.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("drives the documented endpoints in loop order", () => {
    const order = [
      "/api/health",
      "/api/judge/reset",
      "/api/judge/seed",
      "/api/agent/approve",
      "/api/agent/execute",
      "/api/judge/pay",
      "/api/console/summary",
    ];
    let previous = -1;
    for (const path of order) {
      const index = script.indexOf(`"${path}"`);
      expect(index, path).toBeGreaterThan(previous);
      previous = index;
    }
  });

  it("resets before seeding, so it is re-runnable — and says the target must be disposable", () => {
    expect(script.indexOf('"/api/judge/reset"')).toBeLessThan(
      script.indexOf('"/api/judge/seed"'),
    );
    expect(script).toContain("disposable mock-mode demo");
    // A sandbox-mode refusal (409) stops the run, never proceeds.
    expect(script).toContain("reset refused (409)");
  });

  it("passes through the approval gate instead of shortcutting it", () => {
    expect(script).toContain('decision: "approve"');
    expect(script).toContain('"pending_approval"');
    expect(script).toContain('"awaiting_trigger"');
    expect(script).toContain('"completed"');
  });

  it("asserts the README's exact post-loop totals, per currency", () => {
    for (const total of ["570.00", "100.00", "200.00", "280.00", "59.00"]) {
      expect(script, total).toContain(total);
    }
    expect(script).toContain("EXPECTED_COLLECTED");
    expect(script).toContain("EXPECTED_OUTSTANDING");
    expect(script).toContain("EXPECTED_CAPTURED_ORDERS");
    expect(script).toContain("EXPECTED_PAYOUTS_SENT");
    // The same totals are the ones the README promises judges.
    expect(readme).toContain("570.00");
    expect(readme).toContain("280.00");
  });

  it("reads no credential and imports nothing — Node fetch only", () => {
    expect(script).not.toContain("PAYPAL_CLIENT_ID");
    expect(script).not.toContain("PAYPAL_CLIENT_SECRET");
    expect(script).not.toContain("PAYPAL_WEBHOOK_ID");
    expect(script).not.toContain("LLM_API_KEY");
    expect(script).not.toMatch(/^import\s/m);
    expect(script).not.toContain("require(");
    // The one environment variable consulted is the base-URL override.
    expect(script).toContain("process.env");
    expect(script).toContain("SMOKE_BASE_URL");
    const envReads = [...script.matchAll(/process\.env/g)].length;
    expect(envReads).toBe(1);
  });

  it("fails loudly: named step, expected vs actual, exit code 1, request timeout", () => {
    expect(script).toContain("SMOKE FAILED at step");
    expect(script).toContain("process.exit(1)");
    expect(script).toContain("AbortSignal.timeout");
    expect(script).toContain("SMOKE OK");
  });

  it("defaults to the local dev origin and accepts an explicit base URL", () => {
    expect(script).toContain("http://127.0.0.1:3000");
    expect(script).toContain("--base-url");
  });

  it("is documented in the README", () => {
    expect(readme).toContain("npm run smoke");
    expect(readme).toContain("scripts/smoke.mjs");
  });
});
