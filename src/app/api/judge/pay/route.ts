import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { JudgeModeError, simulateJudgeInvoicePayment } from "@/lib/judge";

export const dynamic = "force-dynamic";

/**
 * POST /api/judge/pay — simulate the spine invoice's payment leg.
 *
 * Mock-mode record-payment for the full outstanding amount, followed by
 * the sync reconciler, which processes the INVOICING.INVOICE.PAID event
 * exactly once and resumes the trigger-gated payout. Mock mode only:
 * in sandbox mode it refuses (409) before touching anything — the
 * spine invoice only exists in the mock (see lib/judge/judge-mode.ts).
 * Also refuses (409) when the scenario is not seeded or the spine
 * plan has not been executed.
 */
export async function POST() {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { store, client } = acquired.runtime;
  try {
    const result = await simulateJudgeInvoicePayment(client, store);
    return NextResponse.json({
      alreadyPaid: result.alreadyPaid,
      invoice: result.invoice,
      spinePlanStatus: result.spinePlanStatus,
      sync: result.sync
        ? {
            processedEventIds: result.sync.processedEventIds,
            alreadyProcessedEventIds: result.sync.alreadyProcessedEventIds,
            resumedPlans: result.sync.resumed.map((r) => r.plan.id),
          }
        : null,
    });
  } catch (err) {
    if (err instanceof JudgeModeError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
