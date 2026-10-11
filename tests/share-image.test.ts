import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  alt,
  contentType,
  size,
} from "../src/app/opengraph-image";

const root = process.cwd();
const appDir = join(root, "src", "app");
const readApp = (name: string) => readFileSync(join(appDir, name), "utf8");

describe("Share image (opengraph-image / twitter-image file conventions)", () => {
  it("declares the conventional 1200x630 PNG size, type, and alt text", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
    expect(alt).toBe(
      "LedgerPilot — an AI money operator for solo sellers and freelancers, built on PayPal.",
    );
  });

  it("generates the image with next/og ImageResponse from the app itself", () => {
    const src = readApp("opengraph-image.tsx");
    expect(src).toContain('from "next/og"');
    expect(src).toContain("new ImageResponse(");
    expect(src).toContain("LedgerPilot");
    expect(src).toContain(
      "An AI money operator for solo sellers and freelancers, built on",
    );
  });

  it("uses only the app's own colours (icon ink, page white, status green)", () => {
    const src = readApp("opengraph-image.tsx");
    // #111827 is the icon's background fill / manifest theme colour,
    // #22c55e is the icon's status dot, #ffffff the page background.
    expect(readApp("icon.svg")).toContain('fill="#111827"');
    expect(readApp("icon.svg")).toContain('fill="#22c55e"');
    expect(src).toContain('"#111827"');
    expect(src).toContain('"#22c55e"');
    expect(src).toContain('"#ffffff"');
  });

  it("fetches nothing and declares no external URL (default font only)", () => {
    const src = readApp("opengraph-image.tsx");
    expect(src).not.toMatch(/https?:\/\//);
    expect(src).not.toContain("fetch(");
    expect(src).not.toContain("fonts:");
  });

  it("renders a real PNG of the declared size", async () => {
    const { default: image } = await import("../src/app/opengraph-image");
    const res = image();
    expect(res.headers.get("content-type")).toContain("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // PNG signature, then the IHDR width/height (big-endian uint32s).
    expect(Array.from(bytes.slice(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getUint32(16)).toBe(1200);
    expect(view.getUint32(20)).toBe(630);
  });

  it("twitter-image re-exports the same generated image", () => {
    const src = readApp("twitter-image.tsx");
    expect(src).toContain('from "./opengraph-image"');
    expect(src).toContain("default");
    expect(src).toContain("size");
    expect(src).toContain("contentType");
  });

  it("layout leaves share images to the conventions and uses the large card", () => {
    const src = readApp("layout.tsx");
    expect(src).toContain('card: "summary_large_image"');
    // No hand-declared share image remains (the square SVG icon was the
    // old, crawler-unfriendly value); the conventions supply /opengraph-image.
    expect(src).not.toContain("images:");
    expect(src).not.toContain('url: "/icon.svg"');
  });

  it("layout share copy still agrees with the image alt text", () => {
    const src = readApp("layout.tsx");
    expect(src).toContain(
      'description: "An AI money operator for solo sellers and freelancers, built on PayPal."',
    );
    expect(alt).toContain(
      "an AI money operator for solo sellers and freelancers, built on PayPal.",
    );
  });
});
