import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import SiteNav from "./site-nav";

// Share/theme metadata for the hosted demo. No `metadataBase` and no
// canonical/openGraph `url` is declared: no public URL exists before
// the hosted deployment, and none is invented here. No share image is
// declared here either: the `opengraph-image` / `twitter-image` file
// conventions generate the 1200x630 PNG share card and Next references
// it automatically (the previous hand-declared image was the square
// SVG icon, which share crawlers do not render).
export const metadata: Metadata = {
  title: "LedgerPilot",
  description: "An AI money operator for solo sellers and freelancers, built on PayPal.",
  applicationName: "LedgerPilot",
  openGraph: {
    title: "LedgerPilot",
    description: "An AI money operator for solo sellers and freelancers, built on PayPal.",
    siteName: "LedgerPilot",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "LedgerPilot",
    description: "An AI money operator for solo sellers and freelancers, built on PayPal.",
  },
};

// Matches the manifest's theme_color and the app's primary ink.
export const viewport: Viewport = {
  themeColor: "#111827",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Accessibility: the skip link is the first focusable element on
            every page and jumps past the repeated chrome to the page's
            <main id="main-content" tabIndex={-1}> landmark. It is visually
            hidden until focused (see .skip-link in globals.css). */}
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        {/* Primary navigation: every addressable surface is reachable
            from every page (see src/lib/nav/site-nav.ts). It renders
            after the skip link, so the skip link stays the first
            focusable element and jumps past the nav as well. */}
        <SiteNav />
        {children}
      </body>
    </html>
  );
}
