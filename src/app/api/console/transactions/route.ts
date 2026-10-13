import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { buildTransactionRows } from "../../../../lib/console";

export const dynamic = "force-dynamic";

/** GET /api/console/transactions — Transaction Search rows for reconciliation (read-only). */
export async function GET() {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { client } = acquired.runtime;
  const transactions = await client.listTransactions();
  return NextResponse.json({ transactions: buildTransactionRows(transactions) });
}
