import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "LedgerPilot",
  description: "An AI money operator for solo sellers and freelancers, built on PayPal.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
