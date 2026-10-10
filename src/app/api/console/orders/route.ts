import { NextResponse } from "next/server";
import { getAgentRuntime } from "../../../../lib/agent/runtime";
import { buildOrderRows } from "../../../../lib/console";

export const dynamic = "force-dynamic";

/** GET /api/console/orders — order / checkout rows for the console grid. */
export async function GET() {
  const { client } = getAgentRuntime();
  const orders = await client.listOrders();
  return NextResponse.json({ orders: buildOrderRows(orders) });
}
