#!/usr/bin/env python3
"""Generate `src/app/favicon.ico` — the legacy ICO favicon.

Why this file exists: the app serves its modern icon surfaces through
Next.js file conventions (`icon.svg`, `apple-icon`, the manifest icon),
but browsers, feed readers, and assorted tooling still request
`/favicon.ico` directly, and with no ICO in the app directory that
request 404s. `src/app/favicon.ico` is the App Router convention for
exactly that surface.

The image is the app icon's own motif, redrawn — not traced from a
raster — from the geometry in `src/app/icon.svg` (viewBox 64):

- ink rounded square (#111827), corner radius 12, inset 2
- three white ledger rows (rounded, radius 2.5) at full / 0.65 / 0.40
  opacity, the third row shorter
- the green status dot (#22c55e) centred at (45, 44.5), radius 4

Each ICO entry is a classic 32-bpp BMP (BITMAPINFOHEADER, uncompressed
BGRA, bottom-up) at 16 / 32 / 48 px, rendered per-pixel with 4x4
supersampling so edges and the rows' translucency composite exactly
as the SVG paints them. BMP entries (rather than PNG-compressed ones)
keep this generator dependency-free and let the test suite assert
exact pixel colours straight out of the committed file.

Pure Python standard library — no Pillow, no network:

    python3 scripts/generate-favicon.py

Re-run it whenever the motif in `icon.svg` changes; the output is
deterministic and committed at `src/app/favicon.ico`.
"""

import struct
import sys
from pathlib import Path

INK = (0x11, 0x18, 0x27)
WHITE = (0xFF, 0xFF, 0xFF)
GREEN = (0x22, 0xC5, 0x5E)

SIZES = (16, 32, 48)
SUPERSAMPLE = 4


def in_rounded_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_circle(x, y, cx, cy, r):
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


# Draw order matches icon.svg: background, rows, then the dot on top.
SHAPES = (
    (lambda x, y: in_rounded_rect(x, y, 2, 2, 62, 62, 12), INK, 1.0),
    (lambda x, y: in_rounded_rect(x, y, 14, 16, 50, 21, 2.5), WHITE, 1.0),
    (lambda x, y: in_rounded_rect(x, y, 14, 29, 50, 34, 2.5), WHITE, 0.65),
    (lambda x, y: in_rounded_rect(x, y, 14, 42, 36, 47, 2.5), WHITE, 0.40),
    (lambda x, y: in_circle(x, y, 45, 44.5, 4), GREEN, 1.0),
)


def sample(x, y):
    """Premultiplied RGBA (floats, 0..1) of the motif at a 64-space point."""
    r = g = b = a = 0.0
    for contains, (sr, sg, sb), opacity in SHAPES:
        if contains(x, y):
            sa = opacity
            r = (sr / 255) * sa + r * (1 - sa)
            g = (sg / 255) * sa + g * (1 - sa)
            b = (sb / 255) * sa + b * (1 - sa)
            a = sa + a * (1 - sa)
    return r, g, b, a


def render(size):
    """One ICO image entry: BITMAPINFOHEADER + BGRA pixels + AND mask."""
    xor = bytearray()
    # BMP pixel rows are stored bottom-up.
    for stored_row in range(size):
        j = size - 1 - stored_row  # top-down row index
        for i in range(size):
            pr = pg = pb = pa = 0.0
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    x = (i + (sx + 0.5) / SUPERSAMPLE) / size * 64
                    y = (j + (sy + 0.5) / SUPERSAMPLE) / size * 64
                    r, g, b, a = sample(x, y)
                    pr += r
                    pg += g
                    pb += b
                    pa += a
            n = SUPERSAMPLE * SUPERSAMPLE
            pr, pg, pb, pa = pr / n, pg / n, pb / n, pa / n
            if pa > 0:
                red, green, blue = pr / pa, pg / pa, pb / pa
            else:
                red = green = blue = 0.0
            xor += bytes(
                (
                    round(blue * 255),
                    round(green * 255),
                    round(red * 255),
                    round(pa * 255),
                )
            )
    and_mask = bytes(((size + 31) // 32) * 4 * size)  # 1bpp, row-padded, all clear
    header = struct.pack(
        "<IiiHHIIiiII",
        40,  # biSize
        size,  # biWidth
        size * 2,  # biHeight: XOR mask + AND mask
        1,  # biPlanes
        32,  # biBitCount
        0,  # biCompression: BI_RGB
        len(xor) + len(and_mask),  # biSizeImage
        0,
        0,
        0,
        0,
    )
    return header + bytes(xor) + and_mask


def main():
    images = [render(size) for size in SIZES]
    out = struct.pack("<HHH", 0, 1, len(images))  # reserved, type=icon, count
    offset = 6 + 16 * len(images)
    for size, image in zip(SIZES, images):
        out += struct.pack(
            "<BBBBHHII",
            size,  # bWidth
            size,  # bHeight
            0,  # bColorCount
            0,  # bReserved
            1,  # wPlanes
            32,  # wBitCount
            len(image),  # dwBytesInRes
            offset,  # dwImageOffset
        )
        offset += len(image)
    out += b"".join(images)
    target = Path(__file__).resolve().parent.parent / "src" / "app" / "favicon.ico"
    target.write_bytes(out)
    print(f"wrote {target} ({len(out)} bytes, sizes {', '.join(map(str, SIZES))})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
