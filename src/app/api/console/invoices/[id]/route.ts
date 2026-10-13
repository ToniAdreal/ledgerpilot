import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { buildInvoiceDetail } from "../../../../../lib/console";

export const dynamic = "force-dynamic";

/**
 * GET /api/console/invoices/[id] — one invoice's detail: the grid row
 * projection, line items, the audit timeline of events concerning this
 * invoice, and the plans related to it. 404 for an unknown id.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { client, store } = acquired.runtime;
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
