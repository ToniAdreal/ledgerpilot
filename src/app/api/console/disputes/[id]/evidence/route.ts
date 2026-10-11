import { NextResponse } from "next/server";
import { getAgentRuntime } from "../../../../../../lib/agent/runtime";
import { DisputeEvidenceError, getDisputeEvidenceSummary } from "../../../../../../lib/disputes";

export const dynamic = "force-dynamic";

/**
 * GET /api/console/disputes/[id]/evidence — a deterministic,
 * draft-only dispute-evidence summary assembled from the dispute
 * record, Transaction Search, and the seller's invoices
 * (CONCEPT.md §1 AI component (3)). Read-only: nothing is submitted
 * to PayPal. 404 for an unknown dispute id.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { client } = getAgentRuntime();
  const referenceDate = new Date().toISOString().slice(0, 10);
  try {
    const summary = await getDisputeEvidenceSummary(client, id, referenceDate);
    return NextResponse.json({ summary });
  } catch (err) {
    if (err instanceof DisputeEvidenceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
