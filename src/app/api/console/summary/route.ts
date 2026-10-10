import { NextResponse } from "next/server";
import { getAgentRuntime } from "../../../../lib/agent/runtime";
import { computeSummary } from "../../../../lib/console";

export const dynamic = "force-dynamic";

/** GET /api/console/summary — KPI strip totals for the console home. */
export async function GET() {
  const { client, store } = getAgentRuntime();
  const [invoices, orders, payouts, disputes, transactions] = await Promise.all([
    client.listInvoices(),
    client.listOrders(),
    client.listPayouts(),
    client.listDisputes(),
    client.listTransactions(),
  ]);
  const summary = computeSummary({
    invoices,
    orders,
    payouts,
    disputes,
    transactions,
    plans: store.listPlans(),
    activity: store.listActivity(),
    referenceDate: new Date().toISOString().slice(0, 10),
  });
  return NextResponse.json({ summary });
}
