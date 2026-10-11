import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The contributor-facing half of the community-health facade:
 * CONTRIBUTING.md plus the issue forms and the pull request
 * template. SECURITY.md (pinned in repo-health.test.ts) tells
 * people how to report a flaw; these files tell them how to
 * contribute without breaking the invariants the rest of the
 * suite enforces — the approval gate, the offline verification
 * sequence, fictional demo data, and no credentials anywhere.
 * These tests pin that shape so the guide cannot silently lose
 * the gate, the security routing, or the checklist.
 */

const root = resolve(__dirname, "..");
const contributing = readFileSync(resolve(root, "CONTRIBUTING.md"), "utf8");
const templateDir = resolve(root, ".github/ISSUE_TEMPLATE");
const bugReport = readFileSync(resolve(templateDir, "bug_report.yml"), "utf8");
const featureRequest = readFileSync(
  resolve(templateDir, "feature_request.yml"),
  "utf8",
);
const issueConfig = readFileSync(resolve(templateDir, "config.yml"), "utf8");
const prTemplatePath = resolve(root, ".github/pull_request_template.md");

describe("CONTRIBUTING.md", () => {
  it("documents the exact verification gate CI runs, in order", () => {
    expect(contributing).toContain("npm run typecheck");
    expect(contributing).toContain("npm test");
    expect(contributing).toContain("npm run build");
    const typecheckAt = contributing.indexOf("npm run typecheck");
    const testAt = contributing.indexOf("npm test");
    const buildAt = contributing.indexOf("npm run build");
    expect(typecheckAt).toBeGreaterThan(-1);
    expect(testAt).toBeGreaterThan(typecheckAt);
    expect(buildAt).toBeGreaterThan(testAt);
    expect(contributing).toContain(".github/workflows/ci.yml");
  });

  it("pins the invariants a contribution must not break", () => {
    expect(contributing).toContain("Approval gate");
    expect(contributing.toLowerCase()).toContain("deterministic-first");
    expect(contributing.toLowerCase()).toContain("signature-verified");
    expect(contributing.toLowerCase()).toContain(
      "never summed across currencies",
    );
    expect(contributing.toLowerCase()).toContain("community features only");
  });

  it("routes security flaws to SECURITY.md, never a public issue", () => {
    expect(contributing).toContain("SECURITY.md");
    expect(contributing.toLowerCase()).toContain("never open a public issue");
  });

  it("keeps demo data fictional and credentials out of the tree", () => {
    expect(contributing.toLowerCase()).toContain("fictional");
    expect(contributing.toLowerCase()).toContain("never commit real");
    expect(contributing).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(contributing).not.toMatch(/CLIENT_SECRET\s*=\s*\S+/);
  });

  it("requires tests for new behaviour and forbids auto-merge", () => {
    expect(contributing.toLowerCase()).toContain("new behaviour needs new tests");
    expect(contributing.toLowerCase()).toContain("nothing auto-merges");
  });
});

describe("issue templates", () => {
  it("ships a bug form and a feature form with the expected labels", () => {
    expect(bugReport).toContain("name: Bug report");
    expect(bugReport).toContain('labels: ["bug"]');
    expect(featureRequest).toContain("name: Feature request");
    expect(featureRequest).toContain('labels: ["enhancement"]');
  });

  it("bug form asks for the mode and reproduction steps", () => {
    expect(bugReport).toContain("Mock mode (default, no credentials)");
    expect(bugReport.toLowerCase()).toContain("sandbox mode");
    expect(bugReport).toContain("Steps to reproduce");
    expect(bugReport).toContain("Expected behaviour");
    expect(bugReport).toContain("Actual behaviour");
  });

  it("both forms carry the security and credentials ground rules", () => {
    for (const form of [bugReport, featureRequest]) {
      expect(form.toLowerCase()).toContain("no real-money mode");
    }
    expect(bugReport.toLowerCase()).toContain("do not open a");
    expect(bugReport.toLowerCase()).toContain("never paste real credentials");
    expect(featureRequest.toLowerCase()).toContain("approval gate");
  });

  it("disables blank issues so the templates are always used", () => {
    expect(issueConfig).toContain("blank_issues_enabled: false");
  });

  it("no template carries a credential-shaped value", () => {
    for (const text of [bugReport, featureRequest, issueConfig]) {
      expect(text).not.toMatch(/CLIENT_SECRET\s*=\s*\S+/);
      expect(text).not.toContain("secrets.");
    }
  });
});

describe("pull request template", () => {
  it("exists with the verification checklist in CI order", () => {
    expect(existsSync(prTemplatePath)).toBe(true);
    const prTemplate = readFileSync(prTemplatePath, "utf8");
    expect(prTemplate).toContain("- [ ] `npm run typecheck`");
    expect(prTemplate).toContain("- [ ] `npm test`");
    expect(prTemplate).toContain("- [ ] `npm run build`");
  });

  it("checklists the gate, secrets, and money rules", () => {
    const prTemplate = readFileSync(prTemplatePath, "utf8");
    expect(prTemplate.toLowerCase()).toContain("approval");
    expect(prTemplate.toLowerCase()).toContain("no real credentials");
    expect(prTemplate.toLowerCase()).toContain(
      "never summed across currencies",
    );
    expect(prTemplate.toLowerCase()).toContain("community tier only");
  });
});
