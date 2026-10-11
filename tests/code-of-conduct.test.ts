import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CODE_OF_CONDUCT.md completes the GitHub community-health profile
 * alongside README, LICENSE, SECURITY.md, and CONTRIBUTING.md.
 * These tests pin its shape so the public repo (Nov 1) keeps the
 * Contributor Covenant pledge, standards, enforcement ladder, and
 * a private, honest reporting route — with no invented contact
 * address, the same discipline SECURITY.md is held to.
 */

const root = resolve(__dirname, "..");
const conductPath = resolve(root, "CODE_OF_CONDUCT.md");
const conduct = existsSync(conductPath)
  ? readFileSync(conductPath, "utf8")
  : "";

describe("CODE_OF_CONDUCT.md", () => {
  it("exists at the repo root", () => {
    expect(existsSync(conductPath)).toBe(true);
    expect(conduct.length).toBeGreaterThan(1000);
  });

  it("carries the Covenant pledge for a harassment-free community", () => {
    expect(conduct).toContain("## Our Pledge");
    expect(conduct.toLowerCase()).toContain("harassment-free");
    expect(conduct).toContain("## Our Standards");
  });

  it("names unacceptable behaviour including harassment and private-information publishing", () => {
    expect(conduct.toLowerCase()).toContain("public or private harassment");
    expect(conduct.toLowerCase()).toContain("trolling");
    expect(conduct.toLowerCase()).toContain(
      "publishing others' private information",
    );
  });

  it("routes conduct reports privately through GitHub, never a public issue, with no credential data", () => {
    expect(conduct.toLowerCase()).toContain("privately through github");
    expect(conduct.toLowerCase()).toContain(
      "do not open a public issue for a conduct report",
    );
    expect(conduct.toLowerCase()).toContain("never include real credentials");
  });

  it("keeps the four-step enforcement ladder in order", () => {
    const correction = conduct.indexOf("### 1. Correction");
    const warning = conduct.indexOf("### 2. Warning");
    const temporary = conduct.indexOf("### 3. Temporary Ban");
    const permanent = conduct.indexOf("### 4. Permanent Ban");
    expect(correction).toBeGreaterThan(-1);
    expect(warning).toBeGreaterThan(correction);
    expect(temporary).toBeGreaterThan(warning);
    expect(permanent).toBeGreaterThan(temporary);
  });

  it("attributes the Contributor Covenant version 2.1 with its canonical URL", () => {
    expect(conduct).toContain("Contributor Covenant");
    expect(conduct).toContain("version 2.1");
    expect(conduct).toContain(
      "https://www.contributor-covenant.org/version/2/1/code_of_conduct.html",
    );
  });

  it("invents no contact email address and carries no credential-shaped values", () => {
    expect(conduct).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(conduct).not.toMatch(/CLIENT_SECRET\s*=\s*\S+/);
    expect(conduct).not.toContain("BEGIN");
  });

  it("is referenced from CONTRIBUTING.md", () => {
    const contributing = readFileSync(resolve(root, "CONTRIBUTING.md"), "utf8");
    expect(contributing).toContain("CODE_OF_CONDUCT.md");
  });
});
