/**
 * Webhook handler — the inbound half of the webhook pipeline.
 *
 * Responsibilities (CONCEPT.md §3.1 / §3.2):
 *  - Verify the event signature through the PayPal adapter
 *    (`verifyWebhookSignature`) before trusting anything in the payload.
 *    An unverified event is rejected, never marked processed, and never
 *    resumes a plan — the rejection itself is written to the audit log.
 *  - Distinguish a verification that *failed* from one that could not
 *    be *completed*: in sandbox mode verification is a PayPal API call,
 *    and that call can itself fail (endpoint unreachable, timeout,
 *    upstream error). A throw from the adapter is therefore caught and
 *    reported as `verification_unavailable` — the event is not marked
 *    processed (a redelivery can succeed once verification recovers),
 *    it is never recorded as a signature rejection (the signature was
 *    never judged), and the route answers 502 so PayPal's retry loop
 *    redelivers instead of the event being dropped on an opaque 500.
 *  - Enforce event-id idempotency via the ledger store: a redelivered
 *    event (PayPal retries webhooks) is acknowledged as a duplicate and
 *    produces no second PayPal call.
 *  - Record every verified event in the append-only activity log.
 *  - Resume trigger-gated plan steps (e.g. a payout gated on
 *    INVOICING.INVOICE.PAID) through the executor — the only code path
 *    that turns an event into money movement.
 */

import type { PayPalClient } from "../paypal/client";
import type { WebhookEvent, WebhookEventType } from "../types";
import { resumeTriggeredSteps, type ExecutionResult } from "./executor";
import type { LedgerStore } from "./store";

export type WebhookOutcome =
  | "processed"
  | "duplicate"
  | "rejected_signature"
  | "verification_unavailable";

export interface WebhookHandleResult {
  outcome: WebhookOutcome;
  eventId: string;
  eventType: string;
  /** Plans resumed by this event (empty for duplicates / rejections / unrelated events). */
  resumed: ExecutionResult[];
  /** Why verification could not be completed (only for `verification_unavailable`). */
  verificationError?: string;
}

export interface HandleWebhookInput {
  store: LedgerStore;
  client: PayPalClient;
  /** Header names are matched case-insensitively; routes normalize to lower-case. */
  headers: Record<string, string>;
  event: WebhookEvent;
}

/** Lower-case every header name so callers can pass raw HTTP headers. */
export function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

export async function handleWebhookEvent(input: HandleWebhookInput): Promise<WebhookHandleResult> {
  const { store, client, event } = input;
  const headers = normalizeHeaders(input.headers);

  // The resource the event *claims* to concern. Recorded on every
  // outcome — including rejections — so per-resource audit views (the
  // invoice detail timeline) can show that an unverified event naming
  // this resource was refused. The summaries keep the outcome
  // unmistakable; the id alone never implies trust.
  const claimedResourceId = typeof event.resource?.id === "string" ? event.resource.id : undefined;
  const resourceDetail = claimedResourceId ? { resourceId: claimedResourceId } : {};

  let verified: boolean;
  try {
    verified = await client.verifyWebhookSignature(headers, event);
  } catch (err) {
    // Verification could not be completed — the signature was never
    // judged, so this is not a rejection. The event stays unprocessed
    // (a redelivery after recovery is handled normally), nothing is
    // resumed, and the audit record keeps the outcome unmistakable.
    const verificationError = err instanceof Error ? err.message : String(err);
    store.record({
      kind: "webhook",
      summary: `Webhook ${event.id} (${event.event_type}) VERIFICATION UNAVAILABLE — signature verification could not be completed (${verificationError}); event not processed, a redelivery will be retried`,
      detail: { eventId: event.id, eventType: event.event_type, verified: false, verificationUnavailable: true, error: verificationError, ...resourceDetail },
    });
    return { outcome: "verification_unavailable", eventId: event.id, eventType: event.event_type, resumed: [], verificationError };
  }
  if (!verified) {
    store.record({
      kind: "webhook",
      summary: `Webhook ${event.id} (${event.event_type}) REJECTED — signature verification failed`,
      detail: { eventId: event.id, eventType: event.event_type, verified: false, ...resourceDetail },
    });
    return { outcome: "rejected_signature", eventId: event.id, eventType: event.event_type, resumed: [] };
  }

  if (!store.markEventProcessed(event.id)) {
    store.record({
      kind: "webhook",
      summary: `Webhook ${event.id} (${event.event_type}) duplicate delivery — already processed, ignored`,
      detail: { eventId: event.id, eventType: event.event_type, duplicate: true, ...resourceDetail },
    });
    return { outcome: "duplicate", eventId: event.id, eventType: event.event_type, resumed: [] };
  }

  store.record({
    kind: "webhook",
    summary: `Webhook ${event.id} (${event.event_type}) verified: ${event.summary}`,
    detail: { eventId: event.id, eventType: event.event_type, verified: true, resource: event.resource },
  });

  // Resource-correlated resumption: the event's resource id (the paid
  // invoice's id on INVOICING.INVOICE.PAID) must match the resource a
  // plan's gated step was bound to at execution time — an event about a
  // different invoice never releases this plan's payout.
  const resourceId = typeof event.resource?.id === "string" ? event.resource.id : undefined;
  const resumed = await resumeTriggeredSteps(store, client, event.event_type as WebhookEventType, resourceId);
  return { outcome: "processed", eventId: event.id, eventType: event.event_type, resumed };
}
