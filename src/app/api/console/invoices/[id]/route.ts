import { NextResponse } from "next/server";
import { getAgentRuntime } from "../../../../../lib/agent/runtime";
import { buildInvoiceDetail } from "../../../../../lib/console";

export const dynamic = "force-dynamic";

/**
 * GET /api/console/invoices/[id] — one invoice's detail: the grid row
 * projection, line items, the audit timeline of events concerning this
 * invoice, and the plans related to it. 404 for an unknown id.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { client, store } = getAgentRuntime();
  const invoice = (await client.listInvoices()).find((i) => i.id === id);
  if (!invoice) {
    return NextResponse.json({ error: `Unknown invoice: ${id}` }, { status: 404 });
  }
  const referenceDate = new Date().toISOString().slice(0, 10);
  return NextResponse.json({
    detail: buildInvoiceDetail({
      invoice,
      activity: store.listActivity(),
      plans: store.listPlans(),
      referenceDate,
    }),
  });
}
