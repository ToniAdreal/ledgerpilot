import { NextResponse } from "next/server";
import { getAgentRuntime } from "../../../../lib/agent/runtime";
import { buildActivityRows } from "../../../../lib/console";

export const dynamic = "force-dynamic";

/** GET /api/console/activity — agent activity + webhook audit rows. */
export async function GET() {
  const { store } = getAgentRuntime();
  return NextResponse.json({ activity: buildActivityRows(store.listActivity()) });
}
