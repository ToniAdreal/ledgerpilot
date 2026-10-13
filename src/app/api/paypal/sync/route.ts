import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { syncFromPayPal } from "@/lib/agent";

/**
 * GET /api/paypal/sync — polling reconciler (webhook fallback).
 * Processes any event/state the webhook listener has not seen and
 * resumes trigger-gated plans. Safe to call repeatedly (idempotent).
 */
export async function GET() {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { store, client } = acquired.runtime;
  const result = await syncFromPayPal(store, client);
  return NextResponse.json({
    checked: result.checked,
    processedEventIds: result.processedEventIds,
    alreadyProcessedEventIds: result.alreadyProcessedEventIds,
    resumedPlans: result.resumed.map((r) => r.plan.id),
    state: result.state,
  });
}
