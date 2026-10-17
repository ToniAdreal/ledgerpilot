import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CHANGELOG.md is the curated release history for the public repo.
 * These tests pin its honesty rules in particular: LedgerPilot has
 * NOT been publicly released, so no version may be claimed as
 * released — the 0.1.0 section stays pending until the Nov 1 launch,
 * and the changelog's version must agree with package.json.
 */

const root = resolve(__dirname, "..");
const changelogPath = resolve(root, "CHANGELOG.md");
const changelog = existsSync(changelogPath)
  ? readFileSync(changelogPath, "utf8")
  : "";

describe("CHANGELOG.md", () => {
  it("exists at the repo root", () => {
    expect(existsSync(changelogPath)).toBe(true);
    expect(changelog.length).toBeGreaterThan(1000);
  });

  it("follows Keep a Changelog with Semantic Versioning", () => {
    expect(changelog).toContain("https://keepachangelog.com/en/1.1.0/");
    expect(changelog).toContain("https://semver.org/spec/v2.0.0.html");
  });

  it("keeps everything under Unreleased and claims no released version", () => {
    expect(changelog).toContain("## [Unreleased]");
    expect(changelog.toLowerCase()).toContain("has not been publicly released yet");
    expect(changelog).toContain("## [0.1.0] — pending");
    // No dated release heading like "## [0.1.0] - 2026-10-11" may appear
    // before the actual launch.
    expect(changelog).not.toMatch(/## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}/);
  });

  it("agrees with the package.json version", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      version: string;
    };
    expect(changelog).toContain(`[${pkg.version}]`);
    expect(changelog.toLowerCase()).toContain("2026-11-01");
  });

  it("summarises the shipped capabilities, not aspirations", () => {
    for (const phrase of [
      "Approval-gated agent pipeline",
      "signature-verified",
      "AG Grid operations console",
      "Ask-the-grid",
      "Judge Mode",
      "Payout batch builder",
      "Optional LLM adapter",
      "GET /api/health",
    ]) {
      expect(changelog).toContain(phrase);
    }
  });

  it("keeps the honesty notes: sandbox live-verified, grouping not used", () => {
    expect(changelog.toLowerCase()).toContain(
      "exercised end to end against a live",
    );
    expect(changelog.toLowerCase()).not.toContain(
      "not yet been exercised against a live",
    );
    expect(changelog.toLowerCase()).toContain("community edition only");
    expect(changelog.toLowerCase()).toContain("never summed across currencies");
  });

  it("invents no contact email and carries no credential-shaped values", () => {
    expect(changelog).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(changelog).not.toMatch(/CLIENT_SECRET\s*=\s*\S+/);
    expect(changelog).not.toContain("BEGIN");
  });

  it("is referenced from the README", () => {
    const readme = readFileSync(resolve(root, "README.md"), "utf8");
    expect(readme).toContain("CHANGELOG.md");
  });
});
