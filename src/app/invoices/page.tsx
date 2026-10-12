import type { Metadata } from "next";
import InvoicesClient from "./invoices-client";

// Page-specific metadata for the standalone invoice list page
// (CONCEPT.md §3.1 lists /invoices as "invoice list + detail
// (status timeline fed by webhooks)" — the detail half lives at
// /invoices/[id]; this page is the list half as its own route).
// No URL is declared: no public host exists before the hosted
// deployment, and none is invented here (same rule as the root
// layout's metadata).
export const metadata: Metadata = {
  title: "LedgerPilot — Invoices",
  description:
    "Every PayPal invoice LedgerPilot operates, in one full-width list: recipient, status, amount billed and still due, due date, and overdue flag, each row linking to its detail timeline. Sandbox / mock only — no real money moves.",
};

export default function InvoicesPage() {
  return (
    <main id="main-content" tabIndex={-1} style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: 1180, padding: "0 1rem" }}>
      <p>
        <a href="/">← Operations Console</a>
      </p>
      <h1>Invoices</h1>
      <p>
        The invoice list gets its own page: every invoice the agent has drafted, sent, and
        tracked through PayPal, in the full-width view — recipient, status, amount billed and
        still due, due date, and whether an open invoice is overdue. Each invoice number links
        to its detail page at <code>/invoices/[id]</code>, where the status timeline fed by
        verified webhooks and the sync reconciler is shown for that one invoice. The same rows
        feed the console&apos;s Invoices grid; this page is the deep-linkable list view of
        that surface. Read-only as a list: nothing here creates an invoice, records a
        payment, approves a plan, or moves money — those actions stay in the{" "}
        <a href="/">Operations Console</a>, and the demo scenario starts in{" "}
        <a href="/judge">Judge Mode</a>.
      </p>
      <InvoicesClient />
    </main>
  );
}
