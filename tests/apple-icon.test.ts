import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contentType, size } from "../src/app/apple-icon";

const root = process.cwd();
const appDir = join(root, "src", "app");
const readApp = (name: string) => readFileSync(join(appDir, name), "utf8");

describe("Apple touch icon (apple-icon file convention)", () => {
  it("declares the conventional 180x180 PNG size and type", () => {
    expect(size).toEqual({ width: 180, height: 180 });
    expect(contentType).toBe("image/png");
  });

  it("generates the image with next/og ImageResponse from the app itself", () => {
    const src = readApp("apple-icon.tsx");
    expect(src).toContain('from "next/og"');
    expect(src).toContain("new ImageResponse(");
  });

  it("uses only the app icon's own colours (ink, white rows, status green)", () => {
    const src = readApp("apple-icon.tsx");
    expect(readApp("icon.svg")).toContain('fill="#111827"');
    expect(readApp("icon.svg")).toContain('fill="#22c55e"');
    expect(src).toContain('"#111827"');
    expect(src).toContain('"#22c55e"');
    expect(src).toContain('"#ffffff"');
  });

  it("is full-bleed (Apple masks the corners; no inset rounded square)", () => {
    const src = readApp("apple-icon.tsx");
    // The root element paints the whole canvas with the icon ink.
    expect(src).toContain('background: "#111827"');
    expect(src).toContain('width: "100%"');
    expect(src).toContain('height: "100%"');
    // No borderRadius on the root container: the only radii in the
    // file are the ledger bars' and the status dot's.
    const rootBlock = src.slice(src.indexOf("<div"), src.indexOf(">", src.indexOf("<div")));
    expect(rootBlock).not.toContain("borderRadius");
  });

  it("fetches nothing and declares no external URL (no custom fonts)", () => {
    const src = readApp("apple-icon.tsx");
    expect(src).not.toMatch(/https?:\/\//);
    expect(src).not.toContain("fetch(");
    expect(src).not.toContain("fonts:");
  });

  it("renders a real PNG of the declared size", async () => {
    const { default: icon } = await import("../src/app/apple-icon");
    const res = icon();
    expect(res.headers.get("content-type")).toContain("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getUint32(16)).toBe(180);
    expect(view.getUint32(20)).toBe(180);
  });

  it("layout leaves the touch icon to the convention (no hand-declared link)", () => {
    const src = readApp("layout.tsx");
    expect(src).not.toContain("apple-touch-icon");
    expect(src).not.toContain("apple-icon");
  });

  it("is documented in the README alongside the app icon", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toContain("apple-icon");
    expect(readme).toContain("180×180");
  });
});
