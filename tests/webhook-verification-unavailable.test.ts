import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LedgerStore,
  executePlan,
  handleWebhookEvent,
  parseBrief,
} from "@/lib/agent";
import { API_OPERATIONS, RUNTIME_NOT_CONFIGURED_RESPONSE, apiOperationResponses, buildOpenApiDocument } from "@/lib/api";
import { MockPayPalClient, mockTransmissionSig } from "@/lib/paypal";
import type { WebhookEvent } from "@/lib/types";

/**
 * Webhook verification-unavailable — the third verification outcome.
 *
 * Signature verification in sandbox mode is itself a PayPal API call,
 * and that call can fail (endpoint unreachable, the sandbox timeout,
 * an upstream error). Until this chunk a throw from the adapter's
 * `verifyWebhookSignature` escaped the handler: the route answered an
 * opaque framework 500, and an operator reading the audit log could
 * not tell a verification outage from a signature rejection. The
 * handler now catches the throw and reports
 * `verification_unavailable`: the event is NOT marked processed (a
 * redelivery after recovery processes normally), it is never recorded
 * as REJECTED, nothing is resumed, and the route answers a structured
 * 502 so PayPal's retry loop redelivers the event.
 */

const NOW = new Date("2026-10-10T12:00:00Z");
const DEMO_BRIEF =
  "Invoice Ana $450 for brand work, due Friday. When it lands, pay $200 to my contractor Marco.";
const VERIFY_FAILURE = "POST /v1/notifications/verify-webhook-signature timed out after 10000 ms (REQUEST_TIMEOUT)";

/** Set up a plan whose payout is deferred, awaiting INVOICING.INVOICE.PAID. */
async function setupAwaitingPayout() {
  const store = new LedgerStore();
  const client = new MockPayPalClient();
  const plan = store.addPlan(parseBrief(DEMO_BRIEF, { now: NOW, planId: "plan-wh-u1" }));
  store.approvePlan(plan.id);
  await executePlan(store, client, plan.id);
  const [invoice] = await client.listInvoices();
  await client.recordInvoicePayment(invoice!.id, { value: "450.00", currency_code: "USD" });
  const event = client.emittedEvents.find((e) => e.event_type === "INVOICING.INVOICE.PAID")!;
  return { store, client, plan, invoice: invoice!, event };
}

function signedHeaders(event: WebhookEvent, transmissionId = "trans-0001") {
  return {
    "paypal-transmission-id": transmissionId,
    "paypal-transmission-sig": mockTransmissionSig(transmissionId, event.id),
  };
}

/** A mock client whose verification call throws, as the sandbox adapter's can. */
function throwingVerifyClient(message = VERIFY_FAILURE) {
  const client = new MockPayPalClient();
  client.verifyWebhookSignature = async () => {
    throw new Error(message);
  };
  return client;
}

describe("webhook verification unavailable", () => {
  it("reports verification_unavailable, carries the reason, and marks nothing processed", async () => {
    const { store, plan, event } = await setupAwaitingPayout();
    const client = throwingVerifyClient();
    const result = await handleWebhookEvent({ store, client, headers: signedHeaders(event), event });
    expect(result.outcome).toBe("verification_unavailable");
    expect(result.verificationError).toBe(VERIFY_FAILURE);
    expect(result.resumed).toHaveLength(0);
    expect(store.hasProcessedEvent(event.id)).toBe(false);
    expect(store.getPlan(plan.id)!.status).toBe("awaiting_trigger");
    expect(await client.listPayouts()).toHaveLength(0);
  });

  it("audits the outage distinctly — never as a signature rejection", async () => {
    const { store, event } = await setupAwaitingPayout();
    const client = throwingVerifyClient();
    await handleWebhookEvent({ store, client, headers: signedHeaders(event), event });
    const rows = store.listActivity().filter((a) => a.kind === "webhook");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toContain("VERIFICATION UNAVAILABLE");
    expect(rows[0]!.summary).toContain("not processed");
    expect(rows[0]!.summary).not.toContain("REJECTED");
    expect(rows[0]!.detail?.verificationUnavailable).toBe(true);
    expect(rows[0]!.detail?.verified).toBe(false);
    expect(rows[0]!.detail?.error).toBe(VERIFY_FAILURE);
  });

  it("a redelivery after verification recovers processes normally and closes the loop exactly once", async () => {
    const { store, client, plan, event } = await setupAwaitingPayout();
    const down = throwingVerifyClient();
    const first = await handleWebhookEvent({ store, client: down, headers: signedHeaders(event), event });
    expect(first.outcome).toBe("verification_unavailable");

    const recovered = await handleWebhookEvent({ store, client, headers: signedHeaders(event), event });
    expect(recovered.outcome).toBe("processed");
    expect(recovered.resumed.map((r) => r.plan.id)).toEqual([plan.id]);
    expect(store.getPlan(plan.id)!.status).toBe("completed");
    expect(await client.listPayouts()).toHaveLength(1);

    const redelivery = await handleWebhookEvent({ store, client, headers: signedHeaders(event), event });
    expect(redelivery.outcome).toBe("duplicate");
    expect(await client.listPayouts()).toHaveLength(1);
  });

  it("an already-processed event redelivered during an outage is unavailable, not a duplicate", async () => {
    const { store, client, event } = await setupAwaitingPayout();
    const processed = await handleWebhookEvent({ store, client, headers: signedHeaders(event), event });
    expect(processed.outcome).toBe("processed");

    // Verification runs before the idempotency check, so during an
    // outage the handler cannot even confirm the redelivery is a
    // duplicate — it reports unavailable, and the processed marker
    // from the first delivery is untouched.
    const down = throwingVerifyClient();
    const duringOutage = await handleWebhookEvent({ store, client: down, headers: signedHeaders(event), event });
    expect(duringOutage.outcome).toBe("verification_unavailable");
    expect(store.hasProcessedEvent(event.id)).toBe(true);
    expect(await client.listPayouts()).toHaveLength(1);
  });

  it("a non-Error throw is stringified into the verification error", async () => {
    const { store, event } = await setupAwaitingPayout();
    const client = new MockPayPalClient();
    client.verifyWebhookSignature = async () => {
      // eslint-disable-next-line no-throw-literal
      throw "verify endpoint unreachable";
    };
    const result = await handleWebhookEvent({ store, client, headers: signedHeaders(event), event });
    expect(result.outcome).toBe("verification_unavailable");
    expect(result.verificationError).toBe("verify endpoint unreachable");
    expect(store.hasProcessedEvent(event.id)).toBe(false);
  });

  it("the webhook route maps verification_unavailable to a structured 502", () => {
    const route = readFileSync(
      join(process.cwd(), "src/app/api/paypal/webhooks/route.ts"),
      "utf8",
    );
    expect(route).toContain('result.outcome === "verification_unavailable"');
    expect(route).toContain("status: 502");
    expect(route).toContain("was not processed and a redelivery will be retried");
    // The bad-signature mapping is unchanged.
    expect(route).toContain("status: 401");
  });

  it("the OpenAPI registry declares the webhook 502, and the shared 503 stays the runtime one", () => {
    const op = API_OPERATIONS.find((o) => o.operationId === "receivePayPalWebhook");
    expect(op).toBeDefined();
    expect(op!.responses["502"]).toMatch(/could not be completed/);
    expect(op!.responses["502"]).toMatch(/not recorded as a signature rejection/);
    expect(op!.description).toMatch(/distinct outcome from a failed signature/);
    const responses = apiOperationResponses(op!);
    expect(responses["503"]).toBe(RUNTIME_NOT_CONFIGURED_RESPONSE);

    const doc = buildOpenApiDocument() as unknown as {
      paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>>;
    };
    const built = doc.paths["/api/paypal/webhooks"]!.post!.responses;
    expect(built["502"]!.description).toMatch(/could not be completed/);
    expect(built["503"]!.description).toBe(RUNTIME_NOT_CONFIGURED_RESPONSE);
  });

  it("the README documents the verification-unavailable outcome", () => {
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
    expect(readme).toContain("verification unavailable");
    expect(readme).toContain("502");
  });
});
