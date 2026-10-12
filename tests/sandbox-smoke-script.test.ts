import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The sandbox verification smoke is the automated form of the
 * Oct 24 exit test (CONCEPT.md §3.4): once a real sandbox app
 * exists, the invoice leg — and with it the payout and order legs —
 * must run end-to-end against the live sandbox. Until this script
 * existed, that verification would have been another hand-built
 * curl sequence, against an instance whose mode mistakes are
 * expensive (running it at a mock instance would "pass" while
 * proving nothing). Its shape is pinned here: the mode gate first,
 * the approval gate passed through, fictional amounts only, and no
 * credential ever read by the script itself.
 */

const appRoot = resolve(__dirname, "..");
const scriptPath = resolve(appRoot, "scripts/smoke-sandbox.mjs");
const script = readFileSync(scriptPath, "utf8");
const packageJson = JSON.parse(
  readFileSync(resolve(appRoot, "package.json"), "utf8"),
) as { scripts: Record<string, string> };
const readme = readFileSync(resolve(appRoot, "README.md"), "utf8");

describe("sandbox verification smoke (scripts/smoke-sandbox.mjs)", () => {
  it("exists and is wired as the package's smoke:sandbox command", () => {
    expect(existsSync(scriptPath)).toBe(true);
    expect(packageJson.scripts["smoke:sandbox"]).toBe("node scripts/smoke-sandbox.mjs");
    expect(script.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("gates on sandbox mode before drafting anything", () => {
    const healthIndex = script.indexOf('"/api/health"');
    const firstDraftIndex = script.indexOf('"/api/paypal/invoices"');
    expect(healthIndex).toBeGreaterThan(-1);
    expect(healthIndex).toBeLessThan(firstDraftIndex);
    // A mock target is refused by name, and the mock smoke is named
    // as the right tool for that mode.
    expect(script).toContain('mode !== "sandbox"');
    expect(script).toContain("refusing to run");
    expect(script).toContain("npm run smoke");
    // A misconfigured sandbox (health 503) stops at the same step,
    // naming what the health report names.
    expect(script).toContain('"misconfigured"');
    expect(script).toContain("503");
  });

  it("drives the sandbox legs in order, through the app's own surfaces", () => {
    // The leg order lives in main(); the gate calls live in the
    // draftApproveExecute helper each leg passes through.
    const main = script.slice(script.indexOf("async function main()"));
    const order = [
      "/api/health",
      "/api/paypal/invoices",
      "/api/console/invoices",
      "/api/paypal/invoices/record-payment",
      "/api/paypal/payouts",
      "/api/console/payouts",
      "/api/paypal/orders",
      "/api/console/orders",
      "/api/paypal/sync",
    ];
    let previous = -1;
    for (const path of order) {
      const index = main.indexOf(`"${path}"`);
      expect(index, path).toBeGreaterThan(previous);
      previous = index;
    }
    const helper = script.slice(
      script.indexOf("async function draftApproveExecute"),
      script.indexOf("async function main()"),
    );
    expect(helper.indexOf('"/api/agent/approve"')).toBeLessThan(
      helper.indexOf('"/api/agent/execute"'),
    );
  });

  it("passes through the approval gate for every leg instead of shortcutting it", () => {
    expect(script).toContain('decision: "approve"');
    expect(script).toContain('"pending_approval"');
    expect(script).toContain('"approved"');
    // Drafts are the only way in: the wrappers draft, the gate executes.
    expect(script).toContain("draftApproveExecute");
  });

  it("never resets — sandbox resources live at PayPal and cannot be cleared", () => {
    expect(script).not.toContain("/api/judge/reset");
    expect(script).not.toContain("/api/judge/seed");
    expect(script).not.toContain("/api/judge/pay");
    expect(script).toContain("no reset");
  });

  it("uses fictional verification amounts and the fictional counterparty only", () => {
    expect(script).toContain('"Sandbox Check"');
    expect(script).toContain('INVOICE_AMOUNT = "10.00"');
    expect(script).toContain('PAYOUT_AMOUNT = "2.00"');
    expect(script).toContain('ORDER_AMOUNT = "5.00"');
    expect(script).toContain("Sandbox verification invoice");
    expect(script).toContain("Sandbox verification payout");
    expect(script).toContain("Sandbox verification order");
  });

  it("verifies the invoice leg end state: SENT, then PAID via record-payment", () => {
    expect(script).toContain('"SENT"');
    expect(script).toContain('"PAID"');
    expect(script).toContain("alreadyPaid");
  });

  it("accepts a PayPal-accepted payout batch and surfaces refusals verbatim", () => {
    expect(script).toContain("ACCEPTED_PAYOUT_STATUSES");
    for (const status of ["SUCCESS", "UNCLAIMED", "PENDING"]) {
      expect(script).toContain(`"${status}"`);
    }
    expect(script).toContain("serverError");
  });

  it("verifies the buyer checkout link is real, and never attempts capture", () => {
    expect(script).toContain('"payable"');
    expect(script).toContain('startsWith("https://")');
    expect(script).not.toContain("/api/paypal/orders/capture");
    expect(script).toContain("capture not attempted");
  });

  it("reads no credential and imports nothing — Node fetch only", () => {
    expect(script).not.toContain("PAYPAL_CLIENT_ID=");
    expect(script).not.toContain("PAYPAL_CLIENT_SECRET=");
    expect(script).not.toMatch(/^import\s/m);
    expect(script).not.toContain("require(");
    expect(script).toContain("process.env");
    expect(script).toContain("SMOKE_BASE_URL");
    const envReads = [...script.matchAll(/process\.env/g)].length;
    expect(envReads).toBe(1);
  });

  it("fails loudly: named step, expected vs actual, exit code 1, request timeout", () => {
    expect(script).toContain("SANDBOX SMOKE FAILED at step");
    expect(script).toContain("process.exit(1)");
    expect(script).toContain("AbortSignal.timeout");
    expect(script).toContain("SANDBOX SMOKE OK");
  });

  it("defaults to the local dev origin and accepts an explicit base URL", () => {
    expect(script).toContain("http://127.0.0.1:3000");
    expect(script).toContain("--base-url");
  });

  it("is documented in the README", () => {
    expect(readme).toContain("npm run smoke:sandbox");
    expect(readme).toContain("scripts/smoke-sandbox.mjs");
  });
});
