import type { Metadata } from "next";
import ConsoleClient from "./console-client";

// Page-specific metadata for the console — the app's primary surface
// and the page a judge lands on and shares. Without this export the
// console inherited the root layout's bare app name as its title; the
// other pages (Judge Mode, invoice detail, the 404 surface) already
// carry their own. No URL is declared: no public host exists before
// the hosted deployment, and none is invented here (same rule as the
// root layout's metadata).
export const metadata: Metadata = {
  title: "LedgerPilot — Operations Console",
  description:
    "The LedgerPilot operations console: approval-gated PayPal invoices, checkout orders, payouts, disputes, and the agent activity & webhook audit trail. Sandbox / mock only — no real money moves.",
};

export default function HomePage() {
  return (
    <main id="main-content" tabIndex={-1} style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: 1180, padding: "0 1rem" }}>
      <h1>LedgerPilot — Operations Console</h1>
      <p>
        An AI money operator for solo sellers and freelancers. Tell it what happened in plain
        English — it drafts, sends, tracks, and reconciles the money through PayPal, and nothing
        executes without your approval. Every agent action and verified webhook lands in the
        audit grid below.
      </p>
      <ConsoleClient />
      <p style={{ color: "#6b7280", fontSize: 13 }}>
        The audit trail also has its own page at <a href="/activity">/activity</a> — the
        full-width, deep-linkable view of the Activity grid below. The invoice list likewise
        has its own page at <a href="/invoices">/invoices</a>, each row linking to its detail
        timeline. The checkout orders likewise have their own page at{" "}
        <a href="/checkout">/checkout</a>, with the buyer view for each payable order. The
        payouts likewise have their own page at <a href="/payouts">/payouts</a>, one row
        per payout item with its batch context. The Agent Command bar likewise has its
        own page at <a href="/command">/command</a>, the plan-review surface for drafting
        a brief and approving the typed plan. The disputes likewise have their own page
        at <a href="/disputes">/disputes</a>, the read-only list with response deadlines
        and the draft-only evidence summary per dispute. The reconciliation ledger
        likewise has its own page at <a href="/transactions">/transactions</a>, the
        read-only signed Transaction Search ledger behind the KPI totals. The HTTP API
        likewise has its own documentation page at <a href="/api-docs">/api-docs</a>,
        rendered from the same registry as the OpenAPI document. New here?{" "}
        <a href="/judge">Judge Mode</a> seeds the full demo scenario in one click —
        no PayPal account or API key needed. Sandbox / mock mode only — no real money moves.
        Agent pipeline: briefs via{" "}
        <code>POST /api/agent/plan</code>, approval via <code>/api/agent/approve</code>, execution
        via <code>/api/agent/execute</code>; webhooks via <code>POST /api/paypal/webhooks</code>{" "}
        with a polling reconciler at <code>GET /api/paypal/sync</code>.
      </p>
    </main>
  );
}
