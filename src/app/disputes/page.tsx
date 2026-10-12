import type { Metadata } from "next";
import DisputesClient from "./disputes-client";

// Page-specific metadata for the standalone disputes page
// (the Disputes surface is the read-only console grid built in
// the console-completeness runs: open disputes with response
// deadlines, plus the draft-only evidence summary of CONCEPT.md
// §1 AI component (3)). No URL is declared: no public host
// exists before the hosted deployment, and none is invented
// here (same rule as the root layout's metadata).
export const metadata: Metadata = {
  title: "LedgerPilot — Disputes",
  description:
    "Every PayPal dispute on record, read-only: buyer, reason, stage, amount, and the seller-response deadline, with a draft-only evidence summary per dispute. Sandbox / mock only — no real money moves.",
};

export default function DisputesPage() {
  return (
    <main id="main-content" tabIndex={-1} style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: 1180, padding: "0 1rem" }}>
      <p>
        <a href="/">← Operations Console</a>
      </p>
      <h1>Disputes</h1>
      <p>
        The disputes list gets its own page: every dispute from the PayPal Disputes API,
        in the full-width view — buyer, status, stage, reason, amount, and the
        seller-response deadline, with an overdue response deadline highlighted. The
        Disputes integration is read-only end to end: nothing here submits, accepts, or
        escalates anything at PayPal, and the per-dispute Evidence draft is a
        deterministic, draft-only summary for seller review — it is never submitted.
        Seeded demo data is always flagged “Sample”. The same rows feed the
        console&apos;s Disputes grid; this page is the deep-linkable view of that
        surface. The demo scenario starts in <a href="/judge">Judge Mode</a>.
      </p>
      <DisputesClient />
    </main>
  );
}
