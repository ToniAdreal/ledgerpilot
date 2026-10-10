import { NextResponse } from "next/server";
import { getAgentRuntime } from "../../../../lib/agent/runtime";
import { buildDisputeRows } from "../../../../lib/console";

export const dynamic = "force-dynamic";

/** GET /api/console/disputes — dispute rows for the console grid (read-only). */
export async function GET() {
  const { client } = getAgentRuntime();
  const disputes = await client.listDisputes();
  const referenceDate = new Date().toISOString().slice(0, 10);
  return NextResponse.json({ disputes: buildDisputeRows(disputes, referenceDate) });
}
