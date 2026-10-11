import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The CodeQL workflow is part of the publish-ready repository
 * facade: when the repo goes public (Nov 1), the shipped
 * JavaScript/TypeScript should be scanned for security
 * vulnerabilities and coding errors on every push and pull
 * request, with results in GitHub code scanning. These tests pin
 * the workflow's shape so it cannot silently lose the scheduled
 * re-scan, widen its permissions, gain a secret dependency, or
 * start executing build scripts during analysis.
 */

const workflowPath = resolve(__dirname, "../.github/workflows/codeql.yml");
const workflow = readFileSync(workflowPath, "utf8");

describe("CodeQL workflow (.github/workflows/codeql.yml)", () => {
  it("triggers on pushes to main/master, on pull requests, and weekly", () => {
    expect(workflow).toContain("push:");
    expect(workflow).toContain("branches: [main, master]");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain('cron: "37 5 * * 1"');
  });

  it("analyses JavaScript/TypeScript with no build step", () => {
    expect(workflow).toContain("language: javascript-typescript");
    expect(workflow).toContain("build-mode: none");
    // Extraction with build-mode none never runs project scripts.
    expect(workflow).not.toContain("run: npm");
    expect(workflow).not.toContain("autobuild");
  });

  it("runs init before analyze, in the pinned action versions", () => {
    const init = workflow.indexOf("github/codeql-action/init@v3");
    const analyze = workflow.indexOf("github/codeql-action/analyze@v3");
    expect(init).toBeGreaterThan(-1);
    expect(analyze).toBeGreaterThan(init);
    expect(workflow).toContain('category: "/language:${{ matrix.language }}"');
  });

  it("uses only the checkout and CodeQL official actions", () => {
    const usesLines = workflow
      .split("\n")
      .filter((line) => line.includes("uses:"));
    expect(usesLines.length).toBe(3);
    for (const line of usesLines) {
      expect(line).toMatch(
        /(actions\/checkout@v4|github\/codeql-action\/(init|analyze)@v3)/,
      );
    }
  });

  it("needs no secrets and writes only code-scanning results", () => {
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("PAYPAL_CLIENT_SECRET");
    expect(workflow).not.toContain("LLM_API_KEY");
    expect(workflow).toContain("permissions:");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("security-events: write");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("pull-requests: write");
    expect(workflow).not.toContain("issues: write");
  });

  it("runs on the standard runner with a bounded runtime", () => {
    expect(workflow).toContain("runs-on: ubuntu-latest");
    expect(workflow).toContain("timeout-minutes: 20");
    expect(workflow).toContain("fail-fast: false");
  });
});
