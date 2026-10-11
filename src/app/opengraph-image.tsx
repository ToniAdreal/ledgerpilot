import React from "react";
import { ImageResponse } from "next/og";

// Share image (served at /opengraph-image by the App Router file
// convention, and referenced automatically in the Open Graph tags).
// The layout previously pointed og:image at /icon.svg — a 64x64 square
// SVG that the major share crawlers do not render (they expect a large
// raster, conventionally 1200x630), so link previews of the hosted
// demo would have come out blank. This image is generated from the
// app itself at request/build time: colours are the app's own
// (#111827 ink from the icon/manifest theme, #ffffff, and the icon's
// #22c55e status green), the motif is the icon's ledger-rows mark, and
// the copy is the app's exact name + description. No external asset,
// font file, or URL is fetched or declared — the default font only —
// so it renders identically offline, locally, and on the hosted demo.

export const alt =
  "LedgerPilot — an AI money operator for solo sellers and freelancers, built on PayPal.";

export const size = { width: 1200, height: 630 };

export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          background: "#111827",
          color: "#ffffff",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div
            style={{
              width: "360px",
              height: "34px",
              borderRadius: "17px",
              background: "#ffffff",
            }}
          />
          <div
            style={{
              width: "360px",
              height: "34px",
              borderRadius: "17px",
              background: "#ffffff",
              opacity: 0.65,
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: "18px" }}>
            <div
              style={{
                width: "220px",
                height: "34px",
                borderRadius: "17px",
                background: "#ffffff",
                opacity: 0.4,
              }}
            />
            <div
              style={{
                width: "30px",
                height: "30px",
                borderRadius: "15px",
                background: "#22c55e",
              }}
            />
          </div>
        </div>
        <div
          style={{
            marginTop: "56px",
            fontSize: "96px",
            fontWeight: 700,
            letterSpacing: "-2px",
          }}
        >
          LedgerPilot
        </div>
        <div
          style={{
            marginTop: "20px",
            fontSize: "36px",
            lineHeight: 1.35,
            color: "#d1d5db",
            maxWidth: "940px",
          }}
        >
          An AI money operator for solo sellers and freelancers, built on
          PayPal.
        </div>
        <div
          style={{
            marginTop: "44px",
            fontSize: "24px",
            color: "#9ca3af",
          }}
        >
          Approval-gated agent · Sandbox only — no real money moves
        </div>
      </div>
    ),
    { ...size },
  );
}
