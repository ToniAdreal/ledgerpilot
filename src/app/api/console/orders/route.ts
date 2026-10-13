import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { buildOrderRows } from "../../../../lib/console";

export const dynamic = "force-dynamic";

/** GET /api/console/orders — order / checkout rows for the console grid. */
export async function GET() {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { client } = acquired.runtime;
  const orders = await client.listOrders();
  return NextResponse.json({ orders: buildOrderRows(orders) });
}
