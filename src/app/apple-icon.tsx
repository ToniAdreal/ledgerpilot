import React from "react";
import { ImageResponse } from "next/og";

// Apple touch icon (served at /apple-icon by the App Router file
// convention and referenced automatically as the apple-touch-icon).
// iOS / Safari do not use the SVG favicon (src/app/icon.svg) or the
// manifest's SVG icon for the home-screen / touch surface — they expect
// a 180x180 PNG — so without this file the hosted demo would have had
// no touch icon at all on Apple devices. The image is generated from
// the app itself: the icon's own colours (#111827 ink, #ffffff ledger
// rows, #22c55e status green) and its ledger-rows motif, redrawn at
// touch size. The background is deliberately full-bleed with no inset
// rounded rectangle: Apple masks and rounds the corners itself, so an
// inset rounded square (the SVG favicon's shape) would render with
// dark corners inside Apple's mask. No external asset, font file, or
// URL is fetched or declared — the default font only (the motif is
// shapes, not text) — so it renders identically offline, locally, and
// on the hosted demo. The explicit React import keeps the module
// directly invocable outside Next's compiler (the unit suite renders
// it for real), matching opengraph-image.tsx.

export const size = { width: 180, height: 180 };

export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          gap: "18px",
          background: "#111827",
        }}
      >
        <div
          style={{
            width: "100px",
            height: "14px",
            borderRadius: "7px",
            background: "#ffffff",
          }}
        />
        <div
          style={{
            width: "100px",
            height: "14px",
            borderRadius: "7px",
            background: "#ffffff",
            opacity: 0.65,
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div
            style={{
              width: "62px",
              height: "14px",
              borderRadius: "7px",
              background: "#ffffff",
              opacity: 0.4,
            }}
          />
          <div
            style={{
              width: "22px",
              height: "22px",
              borderRadius: "11px",
              background: "#22c55e",
            }}
          />
        </div>
      </div>
    ),
    { ...size },
  );
}
