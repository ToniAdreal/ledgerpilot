/**
 * Webhook handler — the inbound half of the webhook pipeline.
 *
 * Responsibilities (CONCEPT.md §3.1 / §3.2):
 *  - Verify the event signature through the PayPal adapter
 *    (`verifyWebhookSignature`) before trusting anything in the payload.
 *    An unverified event is rejected, never marked processed, and never
 *    resumes a plan — the rejection itself is written to the audit log.
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
  | "rejected_signature";

export interface WebhookHandleResult {
  outcome: WebhookOutcome;
  eventId: string;
  eventType: string;
  /** Plans resumed by this event (empty for duplicates / rejections / unrelated events). */
  resumed: ExecutionResult[];
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

  const verified = await client.verifyWebhookSignature(headers, event);
  if (!verified) {
    store.record({
      kind: "webhook",
      summary: `Webhook ${event.id} (${event.event_type}) REJECTED — signature verification failed`,
      detail: { eventId: event.id, eventType: event.event_type, verified: false },
    });
    return { outcome: "rejected_signature", eventId: event.id, eventType: event.event_type, resumed: [] };
  }

  if (!store.markEventProcessed(event.id)) {
    store.record({
      kind: "webhook",
      summary: `Webhook ${event.id} (${event.event_type}) duplicate delivery — already processed, ignored`,
      detail: { eventId: event.id, eventType: event.event_type, duplicate: true },
    });
    return { outcome: "duplicate", eventId: event.id, eventType: event.event_type, resumed: [] };
  }

  store.record({
    kind: "webhook",
    summary: `Webhook ${event.id} (${event.event_type}) verified: ${event.summary}`,
    detail: { eventId: event.id, eventType: event.event_type, verified: true, resource: event.resource },
  });

  const resumed = await resumeTriggeredSteps(store, client, event.event_type as WebhookEventType);
  return { outcome: "processed", eventId: event.id, eventType: event.event_type, resumed };
}
