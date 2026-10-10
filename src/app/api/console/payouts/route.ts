import { NextResponse } from "next/server";
import { getAgentRuntime } from "../../../../lib/agent/runtime";
import { buildPayoutRows } from "../../../../lib/console";

export const dynamic = "force-dynamic";

/** GET /api/console/payouts — payout item rows (batch context flattened) for the console grid. */
export async function GET() {
  const { client } = getAgentRuntime();
  const payouts = await client.listPayouts();
  return NextResponse.json({ payouts: buildPayoutRows(payouts) });
}
