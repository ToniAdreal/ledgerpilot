import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The repository's community-health files are part of the
 * publish-ready facade: when the repo goes public (Nov 1), SECURITY.md
 * tells judges and contributors how to report a flaw and what the
 * security model actually guarantees, and Dependabot keeps the
 * dependency surface current with reviewed, CI-gated proposals.
 * These tests pin both files' shape so the policy cannot silently
 * lose its reporting path or its honesty limits, and Dependabot
 * cannot gain auto-merge behaviour.
 */

const root = resolve(__dirname, "..");
const security = readFileSync(resolve(root, "SECURITY.md"), "utf8");
const dependabotPath = resolve(root, ".github/dependabot.yml");

describe("SECURITY.md", () => {
  it("routes reports to private vulnerability reporting, never a public issue", () => {
    expect(security).toContain("Report a");
    expect(security).toContain("vulnerability");
    expect(security.toLowerCase()).toContain("privately");
    expect(security.toLowerCase()).toContain("do not open a public issue");
  });

  it("states the sandbox/mock-only scope and no real-money mode", () => {
    expect(security).toContain("PayPal sandbox");
    expect(security.toLowerCase()).toContain("no\nreal-money mode");
    expect(security.toLowerCase()).toContain("mock mode");
  });

  it("documents the enforced security model, not aspirations", () => {
    expect(security).toContain("Approval gate");
    expect(security.toLowerCase()).toContain("signature-verified");
    expect(security.toLowerCase()).toContain("processed exactly once");
    expect(security.toLowerCase()).toContain("environment variables only");
    expect(security.toLowerCase()).toContain("read\n  only");
  });

  it("warns that Judge Mode demo controls belong on a disposable mock instance", () => {
    expect(security).toContain("Judge Mode");
    expect(security.toLowerCase()).toContain("seed and the reset");
    expect(security.toLowerCase()).toContain("refuse to run in sandbox mode");
    expect(security.toLowerCase()).toContain("access controls");
  });

  it("invents no contact address and carries no credential-shaped values", () => {
    expect(security).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(security).not.toMatch(/CLIENT_SECRET\s*=\s*\S+/);
    expect(security).not.toContain("BEGIN");
  });
});

describe(".github/dependabot.yml", () => {
  it("exists and is version 2", () => {
    expect(existsSync(dependabotPath)).toBe(true);
    const dependabot = readFileSync(dependabotPath, "utf8");
    expect(dependabot).toContain("version: 2");
  });

  it("covers npm and github-actions weekly with bounded open PRs", () => {
    const dependabot = readFileSync(dependabotPath, "utf8");
    expect(dependabot).toContain('package-ecosystem: "npm"');
    expect(dependabot).toContain('package-ecosystem: "github-actions"');
    const weekly = dependabot.match(/interval: "weekly"/g) ?? [];
    expect(weekly.length).toBe(2);
    const limits = dependabot.match(/open-pull-requests-limit: 5/g) ?? [];
    expect(limits.length).toBe(2);
    expect(dependabot).toContain('directory: "/"');
  });

  it("proposes only — no auto-merge, no secrets", () => {
    const dependabot = readFileSync(dependabotPath, "utf8");
    expect(dependabot.toLowerCase()).not.toContain("automerge");
    expect(dependabot.toLowerCase()).not.toContain("auto-merge: true");
    expect(dependabot).not.toContain("secrets.");
  });
});
