import { NextResponse } from "next/server";
import { getAgentRuntime } from "../../../../lib/agent/runtime";
import { buildTransactionRows } from "../../../../lib/console";

export const dynamic = "force-dynamic";

/** GET /api/console/transactions — Transaction Search rows for reconciliation (read-only). */
export async function GET() {
  const { client } = getAgentRuntime();
  const transactions = await client.listTransactions();
  return NextResponse.json({ transactions: buildTransactionRows(transactions) });
}
