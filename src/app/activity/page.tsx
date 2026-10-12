import type { Metadata } from "next";
import ActivityClient from "./activity-client";

// Page-specific metadata for the standalone audit page (CONCEPT.md
// §3.1 lists /activity as its own page — "the agent activity +
// webhook event log grid (the audit trail; also the demo's
// money-shot page)"). No URL is declared: no public host exists
// before the hosted deployment, and none is invented here (same
// rule as the root layout's metadata).
export const metadata: Metadata = {
  title: "LedgerPilot — Agent Activity & Webhook Audit",
  description:
    "The full LedgerPilot audit trail on its own page: every agent plan, approval, PayPal call, and verified webhook event in one traceable grid. Sandbox / mock only — no real money moves.",
};

export default function ActivityPage() {
  return (
    <main id="main-content" tabIndex={-1} style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: 1180, padding: "0 1rem" }}>
      <p>
        <a href="/">← Operations Console</a>
      </p>
      <h1>Agent Activity &amp; Webhook Audit</h1>
      <p>
        The audit trail is the product&apos;s trust story, so it gets its own page: every brief,
        plan, approval, PayPal call, verified webhook delivery, and sync-reconciler pass —
        one unbroken, append-only trace from a plain-English brief to money moved, each row
        carrying its plan id and, for webhook rows, the verified event id. The same rows feed
        the console&apos;s Activity grid; this page is the full-width, deep-linkable view of
        that log. Read-only: nothing here executes, approves, or moves money — actions stay
        in the <a href="/">Operations Console</a>, and the demo scenario starts in{" "}
        <a href="/judge">Judge Mode</a>.
      </p>
      <ActivityClient />
    </main>
  );
}
