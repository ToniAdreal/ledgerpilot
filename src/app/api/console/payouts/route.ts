import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { buildPayoutRows } from "../../../../lib/console";

export const dynamic = "force-dynamic";

/** GET /api/console/payouts — payout item rows (batch context flattened) for the console grid. */
export async function GET() {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { client } = acquired.runtime;
  const payouts = await client.listPayouts();
  return NextResponse.json({ payouts: buildPayoutRows(payouts) });
}
