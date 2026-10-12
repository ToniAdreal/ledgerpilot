import type { Metadata } from "next";
import CheckoutClient from "./checkout-client";

// Page-specific metadata for the standalone checkout page
// (CONCEPT.md §3.1 lists /checkout as the "Sell something" flow:
// create an Orders v2 checkout link, show buyer view). No URL is
// declared: no public host exists before the hosted deployment,
// and none is invented here (same rule as the root layout's
// metadata).
export const metadata: Metadata = {
  title: "LedgerPilot — Checkout",
  description:
    "Every PayPal checkout order LedgerPilot creates for one-off sales, in one full-width list: description, status, amount, capture state, and the buyer checkout link for each payable order. Sandbox / mock only — no real money moves.",
};

export default function CheckoutPage() {
  return (
    <main id="main-content" tabIndex={-1} style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: 1180, padding: "0 1rem" }}>
      <p>
        <a href="/">← Operations Console</a>
      </p>
      <h1>Checkout — Orders</h1>
      <p>
        The sell side gets its own page: every Orders v2 checkout order the agent has
        created for a one-off sale, in the full-width view — description, status, amount,
        capture state, and the buyer view for each order. A payable order shows its buyer
        checkout link (mock links are labeled as mock, never disguised as a real PayPal
        page); a captured order reads “Paid via checkout” and is never offered a pay link
        again. The same rows feed the console&apos;s Orders / Checkout grid; this page is
        the deep-linkable sell view of that surface. Read-only as a list: nothing here
        creates an order, captures a payment, approves a plan, or moves money — creating
        orders through the Sell form and capturing stay in the{" "}
        <a href="/">Operations Console</a>, and the demo scenario starts in{" "}
        <a href="/judge">Judge Mode</a>.
      </p>
      <CheckoutClient />
    </main>
  );
}
