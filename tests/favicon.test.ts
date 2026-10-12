import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The legacy ICO favicon (`src/app/favicon.ico`). Every modern icon
 * surface is a Next.js file convention (SVG favicon, apple-icon,
 * manifest icon, share card), but browsers and tooling still request
 * `/favicon.ico` directly and it 404'd. The ICO entries are classic
 * 32-bpp BMPs — uncompressed BGRA — so these tests can assert exact
 * pixel colours from the committed file: the motif must be the app
 * icon's own (ink square, white ledger rows at their SVG opacities,
 * green status dot), drawn by the stdlib-only generator script.
 */

const root = process.cwd();
const icoPath = join(root, "src", "app", "favicon.ico");
const ico = existsSync(icoPath) ? readFileSync(icoPath) : Buffer.alloc(0);

interface IcoEntry {
  width: number;
  height: number;
  bitCount: number;
  bytesInRes: number;
  offset: number;
}

function entries(): IcoEntry[] {
  const count = ico.readUInt16LE(4);
  const out: IcoEntry[] = [];
  for (let n = 0; n < count; n++) {
    const at = 6 + n * 16;
    out.push({
      width: ico[at] === 0 ? 256 : ico[at],
      height: ico[at + 1] === 0 ? 256 : ico[at + 1],
      bitCount: ico.readUInt16LE(at + 6),
      bytesInRes: ico.readUInt32LE(at + 8),
      offset: ico.readUInt32LE(at + 12),
    });
  }
  return out;
}

function entryOfSize(size: number): IcoEntry {
  const entry = entries().find((e) => e.width === size);
  if (!entry) throw new Error(`no ${size}px ICO entry`);
  return entry;
}

/** Pixel at top-down (x, y) of an entry, as [r, g, b, a] 0..255. */
function pixel(entry: IcoEntry, x: number, y: number): [number, number, number, number] {
  const size = entry.width;
  const headerSize = ico.readUInt32LE(entry.offset);
  const pixelsAt = entry.offset + headerSize;
  const storedRow = size - 1 - y; // BMP rows are bottom-up
  const at = pixelsAt + (storedRow * size + x) * 4;
  return [ico[at + 2], ico[at + 1], ico[at], ico[at + 3]];
}

/** The pixel whose centre is nearest the 64-space point (icon.svg viewBox). */
function pixelAt64(entry: IcoEntry, gx: number, gy: number): [number, number, number, number] {
  const scale = entry.width / 64;
  return pixel(
    entry,
    Math.min(entry.width - 1, Math.floor(gx * scale)),
    Math.min(entry.height - 1, Math.floor(gy * scale)),
  );
}

function expectClose(actual: readonly number[], expected: readonly number[], tol: number) {
  actual.forEach((value, i) => {
    expect(Math.abs(value - expected[i])).toBeLessThanOrEqual(tol);
  });
}

describe("legacy ICO favicon (src/app/favicon.ico)", () => {
  it("exists at the App Router favicon location with a valid ICONDIR header", () => {
    expect(existsSync(icoPath)).toBe(true);
    expect(ico.length).toBeGreaterThan(1000);
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // type: icon
    expect(ico.readUInt16LE(4)).toBe(3); // three entries
  });

  it("carries 16/32/48 entries, each a 32-bpp BMP of the declared size", () => {
    expect(entries().map((e) => e.width)).toEqual([16, 32, 48]);
    for (const entry of entries()) {
      expect(entry.height).toBe(entry.width);
      expect(entry.bitCount).toBe(32);
      // BITMAPINFOHEADER at the entry offset.
      expect(ico.readUInt32LE(entry.offset)).toBe(40);
      expect(ico.readInt32LE(entry.offset + 4)).toBe(entry.width);
      expect(ico.readInt32LE(entry.offset + 8)).toBe(entry.width * 2); // XOR + AND
      expect(ico.readUInt16LE(entry.offset + 14)).toBe(32);
      expect(entry.offset + entry.bytesInRes).toBeLessThanOrEqual(ico.length);
    }
  });

  it("is transparent outside the icon's rounded square (every size)", () => {
    for (const entry of entries()) {
      expect(pixel(entry, 0, 0)[3]).toBe(0);
      expect(pixel(entry, entry.width - 1, 0)[3]).toBe(0);
    }
  });

  it("paints the icon's ink background and opaque first ledger row (48px)", () => {
    const entry = entryOfSize(48);
    // 64-space (32, 8): inside the square, above the first row.
    expectClose(pixelAt64(entry, 32, 8), [0x11, 0x18, 0x27, 255], 1);
    // 64-space (32, 18.5): the centre of the first (full-opacity) row.
    expectClose(pixelAt64(entry, 32, 18.5), [255, 255, 255, 255], 1);
  });

  it("composites the second row at the SVG's 0.65 opacity over the ink (48px)", () => {
    const entry = entryOfSize(48);
    const blended = [0.65 * 255 + 0.35 * 0x11, 0.65 * 255 + 0.35 * 0x18, 0.65 * 255 + 0.35 * 0x27];
    const [r, g, b, a] = pixelAt64(entry, 32, 31.5);
    expectClose([r, g, b], blended, 3);
    expect(a).toBe(255);
  });

  it("paints the green status dot over the third row (48px)", () => {
    const entry = entryOfSize(48);
    expectClose(pixelAt64(entry, 45, 44.5), [0x22, 0xc5, 0x5e, 255], 1);
  });

  it("still renders the motif at 16px (ink body, transparent corner)", () => {
    const entry = entryOfSize(16);
    expect(pixel(entry, 0, 0)[3]).toBe(0);
    // 64-space (32, 8) at 16px is the square's ink.
    expectClose(pixelAt64(entry, 32, 8), [0x11, 0x18, 0x27, 255], 2);
  });

  it("is generated by the committed stdlib-only script from the icon.svg motif", () => {
    const scriptPath = join(root, "scripts", "generate-favicon.py");
    expect(existsSync(scriptPath)).toBe(true);
    const script = readFileSync(scriptPath, "utf8");
    expect(script).toContain("icon.svg");
    expect(script).toContain("favicon.ico");
    // Standard library only: no Pillow, no third-party imports, no network.
    expect(script).not.toContain("PIL");
    expect(script).not.toContain("urllib");
    expect(script).toMatch(/import struct/);
    // The motif colours in the script are the icon's own.
    expect(readFileSync(join(root, "src", "app", "icon.svg"), "utf8")).toContain('fill="#111827"');
    expect(script).toContain("0x11, 0x18, 0x27");
    expect(script).toContain("0x22, 0xC5, 0x5E");
  });

  it("is left to the file convention (no hand-declared favicon in the layout)", () => {
    const layout = readFileSync(join(root, "src", "app", "layout.tsx"), "utf8");
    expect(layout).not.toContain("favicon");
    expect(layout).not.toContain('rel="icon"');
  });

  it("is documented in the README alongside the other icon surfaces", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toContain("favicon.ico");
    expect(readme).toContain("generate-favicon");
  });
});
