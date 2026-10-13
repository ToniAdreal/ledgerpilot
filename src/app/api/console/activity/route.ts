import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { buildActivityRows } from "../../../../lib/console";

export const dynamic = "force-dynamic";

/** GET /api/console/activity — agent activity + webhook audit rows. */
export async function GET() {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { store } = acquired.runtime;
  return NextResponse.json({ activity: buildActivityRows(store.listActivity()) });
}
