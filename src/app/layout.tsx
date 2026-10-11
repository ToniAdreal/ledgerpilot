import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

// Share/theme metadata for the hosted demo. No `metadataBase` and no
// canonical/openGraph `url` is declared: no public URL exists before
// the hosted deployment, and none is invented here — relative image
// paths resolve against whatever host serves the app.
export const metadata: Metadata = {
  title: "LedgerPilot",
  description: "An AI money operator for solo sellers and freelancers, built on PayPal.",
  applicationName: "LedgerPilot",
  openGraph: {
    title: "LedgerPilot",
    description: "An AI money operator for solo sellers and freelancers, built on PayPal.",
    siteName: "LedgerPilot",
    type: "website",
    images: [{ url: "/icon.svg", alt: "LedgerPilot" }],
  },
  twitter: {
    card: "summary",
    title: "LedgerPilot",
    description: "An AI money operator for solo sellers and freelancers, built on PayPal.",
    images: ["/icon.svg"],
  },
};

// Matches the manifest's theme_color and the app's primary ink.
export const viewport: Viewport = {
  themeColor: "#111827",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
