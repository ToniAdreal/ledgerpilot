import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { handleWebhookEvent } from "@/lib/agent";
import type { WebhookEvent } from "@/lib/types";

/**
 * POST /api/paypal/webhooks — PayPal webhook listener.
 * Signature-verified + event-id idempotent (see lib/agent/webhooks.ts).
 * 401 for a failed signature, 200 for processed and for duplicates
 * (acknowledging a duplicate stops PayPal's retry loop).
 */
export async function POST(req: Request) {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { store, client } = acquired.runtime;
  let event: WebhookEvent;
  try {
    event = (await req.json()) as WebhookEvent;
  } catch {
    return NextResponse.json({ error: "Request body must be a JSON webhook event" }, { status: 400 });
  }
  if (!event?.id || !event?.event_type) {
    return NextResponse.json({ error: "Webhook event requires 'id' and 'event_type'" }, { status: 400 });
  }
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const result = await handleWebhookEvent({ store, client, headers, event });
  if (result.outcome === "rejected_signature") {
    return NextResponse.json({ outcome: result.outcome, eventId: result.eventId }, { status: 401 });
  }
  return NextResponse.json({
    outcome: result.outcome,
    eventId: result.eventId,
    eventType: result.eventType,
    resumedPlans: result.resumed.map((r) => r.plan.id),
  });
}
