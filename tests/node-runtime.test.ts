import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Node 22 is the pinned runtime. Before this file existed, the pin lived
 * only in CI (`node-version: 22`), the Render blueprint (`NODE_VERSION`),
 * and prose in CONTRIBUTING.md — none of which a local runner reads.
 * `package.json` `engines` and `.nvmrc` are the two surfaces npm / nvm /
 * fnm actually consult, so the pin now lives there too, and these tests
 * keep all six sites in agreement: a future bump must move every site
 * at once or fail here. (The sixth site — every stage of the
 * Dockerfile — joined when the container descriptor landed.)
 */

const appRoot = resolve(__dirname, "..");
const read = (name: string) => readFileSync(resolve(appRoot, name), "utf8");

const nvmrcPath = resolve(appRoot, ".nvmrc");
const nvmrc = existsSync(nvmrcPath) ? read(".nvmrc").trim() : "";
const pinnedMajor = nvmrc.replace(/^v/, "");

const packageJson = JSON.parse(read("package.json")) as {
  engines?: { node?: string };
  devDependencies: Record<string, string>;
};
const ciWorkflow = read(".github/workflows/ci.yml");
const blueprint = read("render.yaml");
const contributing = read("CONTRIBUTING.md");
const dockerfile = read("Dockerfile");

describe("node runtime pin", () => {
  it(".nvmrc names a single pinned major version", () => {
    expect(existsSync(nvmrcPath)).toBe(true);
    expect(pinnedMajor).toMatch(/^\d+$/);
    expect(pinnedMajor).toBe("22");
  });

  it("package.json engines floors Node at the pinned major (newer majors not blocked)", () => {
    expect(packageJson.engines?.node).toBe(`>=${pinnedMajor}`);
  });

  it("CI runs the pinned major", () => {
    const match = ciWorkflow.match(/node-version:\s*"?(\d+)"?/);
    expect(match?.[1]).toBe(pinnedMajor);
  });

  it("the deployment blueprint pins the same major", () => {
    const block = blueprint.slice(blueprint.indexOf("- key: NODE_VERSION"));
    expect(block).toContain(`value: "${pinnedMajor}"`);
  });

  it("@types/node tracks the pinned major", () => {
    expect(packageJson.devDependencies["@types/node"]).toMatch(
      new RegExp(`^\\^${pinnedMajor}\\.`),
    );
  });

  it("every Dockerfile stage pins the same major", () => {
    const fromLines = dockerfile
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("FROM "));
    expect(fromLines.length).toBeGreaterThanOrEqual(2);
    for (const line of fromLines) {
      expect(line).toMatch(new RegExp(`^FROM node:${pinnedMajor}-`));
    }
  });

  it("CONTRIBUTING.md states the same pinned major", () => {
    expect(contributing).toContain(
      `Node ${pinnedMajor} is the pinned runtime`,
    );
  });
});
