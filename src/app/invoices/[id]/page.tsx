import InvoiceDetailClient from "./invoice-detail-client";

export const metadata = {
  title: "LedgerPilot — Invoice detail",
  description: "One PayPal invoice: amounts, line items, and the webhook-fed audit timeline.",
};

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main id="main-content" tabIndex={-1} style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: 900, padding: "0 1rem" }}>
      <p>
        <a href="/">← Operations Console</a>
      </p>
      <h1>Invoice detail</h1>
      <p>
        Everything LedgerPilot knows about this invoice in one place: what was billed, what has
        been collected, and the audit timeline of agent calls and verified webhook / sync events
        that moved it — the same append-only log the console's Activity grid shows, filtered to
        this invoice.
      </p>
      <InvoiceDetailClient invoiceId={id} />
    </main>
  );
}
