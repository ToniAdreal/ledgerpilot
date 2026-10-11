"use client";

/**
 * Invoice detail client — loads GET /api/console/invoices/[id] and
 * renders the invoice summary, line items, the webhook-fed status
 * timeline, and related plans. Read-only: every action on an invoice
 * (remind, record payment, gated payout) still goes through the
 * console's approval gate or the Judge Mode payment leg.
 */

import { useCallback, useEffect, useState } from "react";
import type { InvoiceDetail } from "../../../lib/console";

function pillClass(value: string): string {
  return `pill pill-${value.toLowerCase().replace(/[^a-z]+/g, "-")}`;
}

export default function InvoiceDetailClient({ invoiceId }: { invoiceId: string }) {
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/console/invoices/${encodeURIComponent(invoiceId)}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      const json = (await res.json()) as { detail?: InvoiceDetail; error?: string };
      if (!res.ok || !json.detail) {
        setError(json.error ?? `Failed to load invoice (HTTP ${res.status})`);
        return;
      }
      setDetail(json.detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load invoice");
    }
  }, [invoiceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (notFound) {
    return (
      <p className="console-error">
        No invoice with id {invoiceId} exists in this runtime. It may predate a server restart —
        the in-memory store resets with the process. <a href="/">Back to the console</a>.
      </p>
    );
  }
  if (!detail) {
    return <p>{error ? `Invoice failed to load: ${error}` : "Loading invoice…"}</p>;
  }

  const inv = detail.invoice;
  return (
    <section>
      <div className="judge-card">
        <h2>
          {inv.invoiceNumber} — {inv.recipientName}{" "}
          <span className={pillClass(inv.status)}>{inv.status}</span>
          {inv.overdue && <span className="detail-overdue"> Overdue</span>}
        </h2>
        <p>
          Billed to {inv.recipientName} ({inv.recipientEmail}) · Invoice id{" "}
          <span className="detail-mono">{inv.id}</span>
          {inv.dueDate && (
            <>
              {" "}
              · Due {inv.dueDate}
            </>
          )}
          {detail.reference && <> · Reference {detail.reference}</>}
        </p>
        <p>
          Amount <strong>{inv.currency} {inv.amount}</strong> · Collected{" "}
          <strong>
            {inv.currency} {inv.collectedValue.toFixed(2)}
          </strong>{" "}
          · Still due <strong>{inv.currency} {inv.dueAmount}</strong>
        </p>
        {detail.note && <p>Note: {detail.note}</p>}
        <button type="button" className="command-btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      <h2>Line items</h2>
      <table className="detail-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Qty</th>
            <th>Unit</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {detail.items.map((item, i) => (
            <tr key={`${item.name}-${i}`}>
              <td>{item.name}</td>
              <td>{item.quantity}</td>
              <td>
                {item.currency} {item.unitAmount}
              </td>
              <td>
                {item.currency} {item.lineTotal}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Status timeline — fed by webhooks &amp; the audit log</h2>
      {detail.timeline.length === 0 ? (
        <p className="command-hint">
          No audit events concern this invoice yet. The timeline fills from agent PayPal calls,
          verified webhook deliveries, and sync-reconciler processing — an invoice created
          directly through the adapter, outside a plan, starts with an empty trail rather than
          an invented one.
        </p>
      ) : (
        <ol className="timeline">
          {detail.timeline.map((entry) => (
            <li key={entry.id}>
              <div className="timeline-meta">
                <span className={pillClass(entry.kind)}>{entry.kind}</span>{" "}
                <span className="detail-mono">{entry.at}</span>
                {entry.eventId && (
                  <>
                    {" "}
                    · event <span className="detail-mono">{entry.eventId}</span>
                  </>
                )}
                {entry.planId && (
                  <>
                    {" "}
                    · plan <span className="detail-mono">{entry.planId}</span>
                  </>
                )}
              </div>
              <p>{entry.summary}</p>
            </li>
          ))}
        </ol>
      )}

      <h2>Related plans</h2>
      {detail.relatedPlans.length === 0 ? (
        <p className="command-hint">
          No agent plan created, reminded, or is gated on this invoice.
        </p>
      ) : (
        <ul className="judge-list">
          {detail.relatedPlans.map((plan) => (
            <li key={plan.id}>
              <span className="detail-mono">{plan.id}</span>{" "}
              <span className={pillClass(plan.status)}>{plan.status}</span> ({plan.source}) — “
              {plan.brief}”
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
