/**
 * Invoice detail projection — the data behind the `/invoices/[id]`
 * surface (CONCEPT.md §3.1: "invoice list + detail (status timeline
 * fed by webhooks)").
 *
 * The timeline is a pure projection over the append-only audit log:
 * an activity record belongs to an invoice's timeline when it directly
 * concerns that invoice, by any of the correlation rules the writers
 * actually use:
 *  - `detail.invoiceId` — the executor's create/send and remind calls;
 *  - `detail.resource.id` — a verified webhook record stores the full
 *    event resource (the paid invoice on INVOICING.INVOICE.PAID);
 *  - `detail.resourceId` / `detail.boundResourceId` — sync-reconciler
 *    records (which name the resource they processed) and the
 *    trigger-correlation mismatch records;
 *  - `detail.invoiceIds` (array) — the Judge Mode seed record, which
 *    lists every invoice it created.
 *
 * Nothing is invented: an invoice created directly through an adapter
 * with no agent/webhook/sync event concerning it has an honestly
 * empty timeline (the adapter's invoice shape carries no creation
 * timestamp to fabricate one from — the same limitation the console
 * KPIs document). Entries keep store (append) order, which is
 * chronological — a timeline reads oldest first.
 */

import type { ActionPlan, ActivityRecord, Invoice } from "../types";
import { toInvoiceRow, type InvoiceRow } from "./read-models";

export interface InvoiceTimelineEntry {
  /** Activity record id — the stable key. */
  id: string;
  at: string;
  kind: ActivityRecord["kind"];
  summary: string;
  /** Webhook event id when this entry records an event delivery / processing. */
  eventId?: string;
  planId?: string;
}

export interface InvoiceDetailItem {
  name: string;
  quantity: string;
  currency: string;
  unitAmount: string;
  /** quantity × unit amount, formatted to 2dp like PayPal amounts. */
  lineTotal: string;
}

export interface RelatedPlanSummary {
  id: string;
  brief: string;
  status: ActionPlan["status"];
  /** Plan source label: deterministic | llm | api (older plans: deterministic-era default). */
  source: string;
}

export interface InvoiceDetail {
  invoice: InvoiceRow;
  note?: string;
  reference?: string;
  items: InvoiceDetailItem[];
  /** Chronological, oldest first. May be empty — see the header note. */
  timeline: InvoiceTimelineEntry[];
  /** Plans that created, reminded, or are trigger-bound to this invoice. Newest first. */
  relatedPlans: RelatedPlanSummary[];
}

/** Does this audit record directly concern the given invoice? */
export function recordConcernsInvoice(record: ActivityRecord, invoiceId: string): boolean {
  const d = record.detail;
  if (!d) return false;
  if (d.invoiceId === invoiceId) return true;
  if (d.resourceId === invoiceId || d.boundResourceId === invoiceId) return true;
  const resource = d.resource;
  if (resource && typeof resource === "object" && (resource as Record<string, unknown>).id === invoiceId) {
    return true;
  }
  if (Array.isArray(d.invoiceIds) && d.invoiceIds.includes(invoiceId)) return true;
  return false;
}

export function buildInvoiceDetail(input: {
  invoice: Invoice;
  activity: ActivityRecord[];
  plans: ActionPlan[];
  referenceDate: string;
}): InvoiceDetail {
  const { invoice, activity, plans, referenceDate } = input;

  const timeline: InvoiceTimelineEntry[] = activity
    .filter((r) => recordConcernsInvoice(r, invoice.id))
    .map((r) => ({
      id: r.id,
      at: r.createdAt,
      kind: r.kind,
      summary: r.summary,
      eventId: typeof r.detail?.eventId === "string" ? r.detail.eventId : undefined,
      planId: r.planId,
    }));

  const timelinePlanIds = new Set(timeline.map((e) => e.planId).filter((p): p is string => !!p));
  const relatedPlans: RelatedPlanSummary[] = plans
    .filter(
      (p) =>
        timelinePlanIds.has(p.id) ||
        p.steps.some((s) => s.trigger?.resourceId === invoice.id),
    )
    .map((p) => ({ id: p.id, brief: p.brief, status: p.status, source: p.source ?? "deterministic" }))
    .reverse(); // newest first, like every other console projection

  return {
    invoice: toInvoiceRow(invoice, referenceDate),
    note: invoice.detail.note,
    reference: invoice.detail.reference,
    items: invoice.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      currency: item.unit_amount.currency_code,
      unitAmount: item.unit_amount.value,
      lineTotal: (Number(item.quantity) * Number(item.unit_amount.value)).toFixed(2),
    })),
    timeline,
    relatedPlans,
  };
}
