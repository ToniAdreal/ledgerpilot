import type { Metadata } from "next";
import TransactionsClient from "./transactions-client";

// Page-specific metadata for the standalone reconciliation page
// (the Reconciliation grid is the read-only Transaction Search
// surface built in the console-completeness runs: the signed
// transaction ledger behind the console's KPI totals). No URL is
// declared: no public host exists before the hosted deployment,
// and none is invented here (same rule as the root layout's
// metadata).
export const metadata: Metadata = {
  title: "LedgerPilot — Reconciliation",
  description:
    "Every PayPal transaction on record, read-only: the signed Transaction Search ledger — payments in, payouts out — behind the console totals, with payer, subject, status, and amount. Sandbox / mock only — no real money moves.",
};

export default function TransactionsPage() {
  return (
    <main id="main-content" tabIndex={-1} style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: 1180, padding: "0 1rem" }}>
      <p>
        <a href="/">← Operations Console</a>
      </p>
      <h1>Reconciliation — Transaction Search</h1>
      <p>
        The reconciliation ledger gets its own page: every transaction from the PayPal
        Transaction Search API, in the full-width view — date, transaction id, event,
        payer, subject, status, and the signed amount (payments in positive, payouts out
        negative, shown in red). The Transaction Search integration is read-only end to
        end: nothing here creates, captures, refunds, or moves anything at PayPal — this
        is the ledger the console&apos;s KPI totals reconcile against. The same rows feed
        the console&apos;s Reconciliation grid; this page is the deep-linkable view of
        that surface. The demo scenario starts in <a href="/judge">Judge Mode</a>.
      </p>
      <TransactionsClient />
    </main>
  );
}
