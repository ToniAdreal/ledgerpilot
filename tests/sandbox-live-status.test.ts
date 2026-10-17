import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Sandbox live-status honesty: the sandbox adapter was exercised end
 * to end against the live PayPal sandbox on 2026-10-16 (BUILD_LOG
 * BLOCKERS, resolved ahead of the Oct 24 hard deadline; live fixes in
 * commit 378ddec). Every surface that states the adapter's status
 * must say so — a leftover "not yet exercised against a live sandbox"
 * claim would contradict the README, the CHANGELOG, and the Devpost
 * submission draft, and would undersell a verified flow to judges.
 * These tests pin the live-verified wording in the two source-file
 * headers that state it, and forbid the stale claim anywhere in the
 * adapter layer, the README, or the CHANGELOG.
 */

const root = resolve(__dirname, "..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

const sandboxTs = read("src/lib/paypal/sandbox.ts");
const factoryTs = read("src/lib/paypal/index.ts");
const readme = read("README.md");
const changelog = read("CHANGELOG.md");

const STALE_CLAIMS = [
  "not yet been exercised against a live",
  "not yet exercised against a live sandbox",
  "not yet live-verified",
  "not yet been exercised against the live sandbox",
];

describe("sandbox live status (live-verified 2026-10-16)", () => {
  it("sandbox.ts header states the live verification and its date", () => {
    expect(sandboxTs).toContain("2026-10-16");
    expect(sandboxTs.toLowerCase()).toContain(
      "exercised end to end against the live paypal sandbox",
    );
    expect(sandboxTs).toContain("smoke:sandbox");
  });

  it("sandbox.ts header no longer defers verification to a future account", () => {
    expect(sandboxTs.toLowerCase()).not.toContain(
      "not yet been exercised against the live sandbox",
    );
    expect(sandboxTs).not.toContain("hard deadline Oct 24");
  });

  it("the client factory comment agrees with the adapter header", () => {
    expect(factoryTs).toContain("2026-10-16");
    expect(factoryTs.toLowerCase()).toContain("live-verified");
    expect(factoryTs.toLowerCase()).not.toContain(
      "not yet exercised against a live sandbox",
    );
  });

  it("no stale not-yet-live claim survives in the adapter layer, README, or CHANGELOG", () => {
    for (const [name, text] of [
      ["sandbox.ts", sandboxTs],
      ["index.ts", factoryTs],
      ["README.md", readme],
      ["CHANGELOG.md", changelog],
    ] as const) {
      for (const stale of STALE_CLAIMS) {
        expect(text.toLowerCase(), `${name} must not claim: ${stale}`).not.toContain(stale);
      }
    }
  });

  it("README and CHANGELOG state the same live-verified date", () => {
    expect(readme).toContain("2026-10-16");
    expect(readme.toLowerCase()).toContain("live-verified on 2026-10-16");
    expect(changelog).toContain("2026-10-16");
    expect(changelog.toLowerCase()).toContain(
      "exercised end to end against a live",
    );
  });

  it("the live run's three adapter fixes stay named in the sandbox header", () => {
    // The fixes the live run produced (commit 378ddec) are the proof
    // the verification happened; the header keeps them discoverable.
    expect(sandboxTs).toContain("currency");
    expect(sandboxTs.toLowerCase()).toContain("bare");
    expect(sandboxTs.toLowerCase()).toContain("404");
  });
});
