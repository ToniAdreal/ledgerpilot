import type { MetadataRoute } from "next";

// Web App Manifest (served at /manifest.webmanifest by the App Router
// file convention). It carries the app's identity for browsers —
// name, description, theme/background colours, and the app icon —
// and nothing more: LedgerPilot ships no service worker and no
// offline mode, so the manifest does not claim either. Colours are
// the ones the app already uses (icon background / primary ink
// #111827, page background #ffffff in globals.css), and no start URL
// beyond the console root and no external URL is declared — no
// public host exists to point at before the hosted deployment.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "LedgerPilot",
    short_name: "LedgerPilot",
    description:
      "An AI money operator for solo sellers and freelancers, built on PayPal.",
    lang: "en",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#111827",
    categories: ["business", "finance", "productivity"],
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
