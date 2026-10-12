import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The verification gate (typecheck -> test -> build) is the sequence
 * CI runs, CONTRIBUTING.md prescribes, and the Nov 1 publish gate
 * re-runs. Until now it existed only as three separate commands a
 * runner had to type in the right order. `npm run verify` is the
 * single-command form of that exact gate; these tests pin it so the
 * shortcut can never drift from the gate it abbreviates.
 */

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "../package.json"), "utf8"),
) as { scripts: Record<string, string> };
const ci = readFileSync(
  resolve(__dirname, "../.github/workflows/ci.yml"),
  "utf8",
);
const readme = readFileSync(resolve(__dirname, "../README.md"), "utf8");
const contributing = readFileSync(
  resolve(__dirname, "../CONTRIBUTING.md"),
  "utf8",
);
const changelog = readFileSync(resolve(__dirname, "../CHANGELOG.md"), "utf8");

const verify: string = pkg.scripts.verify ?? "";

describe("verification script (npm run verify)", () => {
  it("is exactly the gate sequence joined in order", () => {
    expect(verify).toBe("npm run typecheck && npm test && npm run build");
  });

  it("orders typecheck before test before build", () => {
    const typecheck = verify.indexOf("npm run typecheck");
    const test = verify.indexOf("npm test");
    const build = verify.indexOf("npm run build");
    expect(typecheck).toBeGreaterThan(-1);
    expect(test).toBeGreaterThan(typecheck);
    expect(build).toBeGreaterThan(test);
  });

  it("agrees with the CI workflow's step order", () => {
    const ciTypecheck = ci.indexOf("run: npm run typecheck");
    const ciTest = ci.indexOf("run: npm test");
    const ciBuild = ci.indexOf("run: npm run build");
    expect(ciTypecheck).toBeGreaterThan(-1);
    expect(ciTest).toBeGreaterThan(ciTypecheck);
    expect(ciBuild).toBeGreaterThan(ciTest);
  });

  it("stays offline and self-contained: no install, server, smoke, or credential", () => {
    expect(verify).not.toContain("npm ci");
    expect(verify).not.toContain("npm install");
    expect(verify).not.toContain("npm start");
    expect(verify).not.toContain("smoke");
    expect(verify).not.toContain("curl");
    expect(verify).not.toContain("http");
    expect(verify).not.toContain("PAYPAL");
    expect(verify).not.toContain("SECRET");
    expect(verify).not.toContain("LLM_API_KEY");
  });

  it("references only scripts that exist in package.json", () => {
    for (const name of ["typecheck", "test", "build"]) {
      expect(pkg.scripts[name], `script "${name}"`).toBeTruthy();
      expect(verify).toContain(
        name === "test" ? "npm test" : `npm run ${name}`,
      );
    }
    // The gate steps themselves are unchanged by the shortcut.
    expect(pkg.scripts.typecheck).toBe("tsc --noEmit");
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts.build).toBe("next build");
  });

  it("is documented in the README testing section", () => {
    expect(readme).toContain("npm run verify");
    expect(readme).toContain("single-command form of the gate");
  });

  it("is documented in CONTRIBUTING's gate and the CHANGELOG", () => {
    expect(contributing).toContain("npm run verify");
    expect(changelog).toContain("Verification script");
    expect(changelog).toContain("npm run verify");
  });
});
