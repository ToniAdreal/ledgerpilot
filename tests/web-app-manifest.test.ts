import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../src/app/manifest";

const root = process.cwd();
const appDir = join(root, "src", "app");
const readApp = (name: string) => readFileSync(join(appDir, name), "utf8");

describe("Web App Manifest + share/theme metadata", () => {
  it("manifest returns the app identity with the console root as its start URL", () => {
    const result = manifest();
    expect(result.name).toBe("LedgerPilot");
    expect(result.short_name).toBe("LedgerPilot");
    expect(result.description).toBe(
      "An AI money operator for solo sellers and freelancers, built on PayPal.",
    );
    expect(result.lang).toBe("en");
    expect(result.start_url).toBe("/");
    expect(result.scope).toBe("/");
    expect(result.display).toBe("standalone");
  });

  it("manifest colours match the colours the app already uses", () => {
    const result = manifest();
    // #111827 is the icon's background fill and the console's primary ink;
    // #ffffff is the body background in globals.css.
    expect(readApp("icon.svg")).toContain('fill="#111827"');
    expect(readApp("globals.css")).toContain("background: #ffffff");
    expect(result.theme_color).toBe("#111827");
    expect(result.background_color).toBe("#ffffff");
  });

  it("manifest icon points at the real file-convention icon and nothing external", () => {
    const result = manifest();
    expect(result.icons).toEqual([
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ]);
    expect(existsSync(join(appDir, "icon.svg"))).toBe(true);
  });

  it("manifest declares no external URL and no offline/service-worker claim", () => {
    const src = readApp("manifest.ts");
    expect(src).not.toMatch(/https?:\/\//);
    // The honesty note in the header is what keeps the standalone
    // display mode from reading as an installability promise.
    expect(src).toContain("ships no service worker");
  });

  it("layout metadata names the app and carries Open Graph + Twitter share fields", () => {
    const src = readApp("layout.tsx");
    expect(src).toContain('applicationName: "LedgerPilot"');
    expect(src).toContain("openGraph:");
    expect(src).toContain('siteName: "LedgerPilot"');
    expect(src).toContain('type: "website"');
    expect(src).toContain("twitter:");
    expect(src).toContain('card: "summary_large_image"');
    // Share images come from the opengraph-image / twitter-image file
    // conventions (generated 1200x630 PNG), not a hand-declared icon.
    expect(src).not.toContain("images:");
  });

  it("layout description agrees with the manifest description", () => {
    const src = readApp("layout.tsx");
    expect(src).toContain(
      'description: "An AI money operator for solo sellers and freelancers, built on PayPal."',
    );
    expect(manifest().description).toBe(
      "An AI money operator for solo sellers and freelancers, built on PayPal.",
    );
  });

  it("viewport theme colour matches the manifest theme colour", () => {
    const src = readApp("layout.tsx");
    expect(src).toContain("export const viewport");
    expect(src).toContain('themeColor: "#111827"');
    expect(manifest().theme_color).toBe("#111827");
  });

  it("no invented public URL appears in the layout metadata", () => {
    const src = readApp("layout.tsx");
    expect(src).not.toMatch(/https?:\/\//);
    expect(src).not.toMatch(/metadataBase\s*:/);
    expect(src).not.toMatch(/canonical\s*:/);
  });
});
