import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { buildInvoiceRows } from "../../../../lib/console";

export const dynamic = "force-dynamic";

/** GET /api/console/invoices — invoice rows for the console grid. */
export async function GET() {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { client } = acquired.runtime;
  const invoices = await client.listInvoices();
  const referenceDate = new Date().toISOString().slice(0, 10);
  return NextResponse.json({ invoices: buildInvoiceRows(invoices, referenceDate) });
}
