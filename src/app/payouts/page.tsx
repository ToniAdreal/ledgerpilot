import type { Metadata } from "next";
import PayoutsClient from "./payouts-client";

// Page-specific metadata for the standalone payouts page
// (CONCEPT.md §3.1 lists /payouts as the "payout batch builder:
// agent-drafted batch, per-line validation, approval release" —
// the builder lives in the console; this page is the payouts
// list as its own route). No URL is declared: no public host
// exists before the hosted deployment, and none is invented
// here (same rule as the root layout's metadata).
export const metadata: Metadata = {
  title: "LedgerPilot — Payouts",
  description:
    "Every PayPal payout LedgerPilot has released, in one full-width list: recipient, status, amount, note, and batch, one row per payout item with its batch context flattened in. Sandbox / mock only — no real money moves.",
};

export default function PayoutsPage() {
  return (
    <main id="main-content" tabIndex={-1} style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: 1180, padding: "0 1rem" }}>
      <p>
        <a href="/">← Operations Console</a>
      </p>
      <h1>Payouts</h1>
      <p>
        The payouts list gets its own page: every payout batch the agent has drafted and
        released through the approval gate, in the full-width view — one row per payout
        item with its batch context flattened in: recipient, status, amount, note, and
        the batch it belongs to. A batch drafted in the payout batch builder appears here
        as its individual lines once it is approved and executed, never before. The same
        rows feed the console&apos;s Payouts grid; this page is the deep-linkable list
        view of that surface. Read-only as a list: nothing here drafts a batch, approves
        a plan, releases a payout, or moves money — drafting batches in the payout batch
        builder and releasing them through the approval gate stay in the{" "}
        <a href="/">Operations Console</a>, and the demo scenario starts in{" "}
        <a href="/judge">Judge Mode</a>.
      </p>
      <PayoutsClient />
    </main>
  );
}
