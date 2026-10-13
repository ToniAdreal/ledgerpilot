import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { buildDisputeRows } from "../../../../lib/console";

export const dynamic = "force-dynamic";

/** GET /api/console/disputes — dispute rows for the console grid (read-only). */
export async function GET() {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { client } = acquired.runtime;
  const disputes = await client.listDisputes();
  const referenceDate = new Date().toISOString().slice(0, 10);
  return NextResponse.json({ disputes: buildDisputeRows(disputes, referenceDate) });
}
