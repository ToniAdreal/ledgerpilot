import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `.github/CODEOWNERS` is the review-routing half of the public
 * repo's façade: without it, GitHub requests no reviewer on any
 * pull request. LedgerPilot is a solo project, so every rule names
 * the one project owner — these tests pin that the default rule
 * covers the whole tree, that the security- and automation-
 * sensitive surfaces stay explicitly owned even if the default
 * ever narrows, and that no other owner, email address, or
 * credential-shaped value is published in the file.
 */

const root = resolve(__dirname, "..");
const codeownersPath = resolve(root, ".github", "CODEOWNERS");
const codeowners = existsSync(codeownersPath)
  ? readFileSync(codeownersPath, "utf8")
  : "";
const readme = readFileSync(resolve(root, "README.md"), "utf8");

interface CodeownersRule {
  pattern: string;
  owners: string[];
}

function parseRules(source: string): CodeownersRule[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const [pattern, ...owners] = line.split(/\s+/);
      return { pattern, owners };
    });
}

const rules = parseRules(codeowners);

describe(".github/CODEOWNERS", () => {
  it("exists under .github/", () => {
    expect(existsSync(codeownersPath)).toBe(true);
    expect(codeowners.length).toBeGreaterThan(400);
  });

  it("states the solo-project routing and the usernames-only rule", () => {
    expect(codeowners.toLowerCase()).toContain("solo project");
    expect(codeowners.toLowerCase()).toContain("usernames only");
  });

  it("opens with a default rule covering the whole tree", () => {
    expect(rules.length).toBeGreaterThan(1);
    expect(rules[0].pattern).toBe("*");
    expect(rules[0].owners).toEqual(["@ToniAdreal"]);
  });

  it("names exactly one owner — the project owner — on every rule", () => {
    const allOwners = new Set(rules.flatMap((rule) => rule.owners));
    expect(allOwners).toEqual(new Set(["@ToniAdreal"]));
  });

  it("keeps the security- and automation-sensitive surfaces explicitly owned", () => {
    const patterns = rules.map((rule) => rule.pattern);
    expect(patterns).toContain(".github/workflows/");
    expect(patterns).toContain(".github/dependabot.yml");
    expect(patterns).toContain(".github/CODEOWNERS");
    expect(patterns).toContain("SECURITY.md");
    expect(patterns).toContain("render.yaml");
  });

  it("documents that the last matching pattern wins", () => {
    expect(codeowners.toLowerCase()).toContain("last matching pattern wins");
  });

  it("publishes no email address and no credential-shaped value", () => {
    expect(codeowners).not.toMatch(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    );
    expect(codeowners).not.toMatch(
      /CLIENT_SECRET|API_KEY\s*=|PASSWORD\s*=|ghp_[A-Za-z0-9]/,
    );
  });

  it("is referenced from the README", () => {
    expect(readme).toContain("CODEOWNERS");
  });
});
