import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The CI workflow is part of the publish-ready repository facade:
 * when the repo goes public (Nov 1), judges and contributors should
 * see every push and pull request verified with the exact sequence
 * the README documents. These tests pin the workflow's shape so it
 * cannot silently lose a step, gain a secret dependency, or widen
 * its permissions.
 */

const workflowPath = resolve(__dirname, "../.github/workflows/ci.yml");
const workflow = readFileSync(workflowPath, "utf8");

describe("CI workflow (.github/workflows/ci.yml)", () => {
  it("triggers on pushes to main/master and on pull requests", () => {
    expect(workflow).toContain("push:");
    expect(workflow).toContain("branches: [main, master]");
    expect(workflow).toContain("pull_request:");
  });

  it("runs the documented verification sequence in order", () => {
    const install = workflow.indexOf("run: npm ci");
    const typecheck = workflow.indexOf("run: npm run typecheck");
    const test = workflow.indexOf("run: npm test");
    const build = workflow.indexOf("run: npm run build");
    expect(install).toBeGreaterThan(-1);
    expect(typecheck).toBeGreaterThan(install);
    expect(test).toBeGreaterThan(typecheck);
    expect(build).toBeGreaterThan(test);
  });

  it("pins Node 22 with the npm cache and a bounded runtime", () => {
    expect(workflow).toContain("actions/setup-node@v4");
    expect(workflow).toContain("node-version: 22");
    expect(workflow).toContain("cache: npm");
    expect(workflow).toContain("runs-on: ubuntu-latest");
    expect(workflow).toContain("timeout-minutes: 15");
  });

  it("needs no secrets and keeps permissions read-only", () => {
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("PAYPAL_CLIENT_SECRET");
    expect(workflow).not.toContain("LLM_API_KEY");
    expect(workflow).toContain("permissions:");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("contents: write");
  });

  it("uses pinned major versions of the official actions", () => {
    expect(workflow).toContain("actions/checkout@v4");
    expect(workflow).toContain("actions/setup-node@v4");
    // No unpinned or third-party actions.
    const usesLines = workflow
      .split("\n")
      .filter((line) => line.includes("uses:"));
    expect(usesLines.length).toBe(2);
    for (const line of usesLines) {
      expect(line).toMatch(/actions\/(checkout|setup-node)@v4/);
    }
  });
});
