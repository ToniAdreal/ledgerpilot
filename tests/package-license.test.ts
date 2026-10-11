import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The MIT license is declared in three machine-readable places that
 * must agree: the `LICENSE` file at the repo root (the file GitHub's
 * license detection reads), the `license` field in `package.json`
 * (the metadata npm and other package tooling read), and the root
 * package entry in `package-lock.json` (which npm mirrors from
 * `package.json` — the two drift apart if the lockfile is not
 * re-synced after a metadata change, as the engines pin required).
 * Before this file existed the package metadata carried no license
 * at all, so tooling reading `package.json` alone saw an unlicensed
 * package sitting next to an MIT LICENSE file.
 */

const root = resolve(__dirname, "..");
const read = (name: string) => readFileSync(resolve(root, name), "utf8");

const licensePath = resolve(root, "LICENSE");
const licenseFile = existsSync(licensePath) ? read("LICENSE") : "";

const pkg = JSON.parse(read("package.json")) as {
  license?: string;
  private?: boolean;
};
const lock = JSON.parse(read("package-lock.json")) as {
  packages: { "": { license?: string } };
};
const readme = read("README.md");
const changelog = read("CHANGELOG.md");

describe("package license metadata", () => {
  it("the LICENSE file at the root is the standard MIT text", () => {
    expect(existsSync(licensePath)).toBe(true);
    expect(licenseFile.split("\n")[0]).toBe("MIT License");
    expect(licenseFile).toContain("Copyright (c) 2026 Toni Adreal");
    expect(licenseFile).toContain(
      "Permission is hereby granted, free of charge, to any person obtaining a copy",
    );
  });

  it("package.json declares the SPDX license MIT", () => {
    expect(pkg.license).toBe("MIT");
  });

  it("the declared license is a single SPDX identifier, not a pointer or a denial", () => {
    expect(pkg.license).toMatch(/^[A-Za-z0-9-.+]+$/);
    expect(pkg.license).not.toBe("UNLICENSED");
    expect(pkg.license).not.toContain("SEE LICENSE");
  });

  it("package-lock.json's root entry mirrors the package.json license", () => {
    expect(lock.packages[""].license).toBe(pkg.license);
  });

  it("the package metadata license names the same license as the LICENSE file", () => {
    // "MIT" in package.json <-> "MIT License" as the LICENSE heading.
    expect(licenseFile.split("\n")[0]).toBe(`${pkg.license} License`);
  });

  it("the README License section states MIT and links the LICENSE file", () => {
    const section = readme.slice(readme.indexOf("## License"));
    expect(section).toContain("MIT");
    expect(section).toContain("[LICENSE](./LICENSE)");
    expect(section).toContain("package.json");
  });

  it("no shipped doc claims a different license, and the app stays private", () => {
    expect(changelog).toContain("MIT `LICENSE`");
    // `private: true` is deliberate for an app repo (see
    // PUBLISH_PACKAGE): the license grants the code's terms, it does
    // not publish the package to a registry.
    expect(pkg.private).toBe(true);
  });
});
