import { NextResponse } from "next/server";
import { getAgentRuntime, resolveReferenceDate, suggestNextActions, SuggestionError } from "@/lib/agent";

export const dynamic = "force-dynamic";

/**
 * POST /api/agent/suggest — the agent's next-action draft step
 * (CONCEPT.md §3.1 data flow: after state updates, "the agent drafts
 * the *next* action (reminder / payout) as a new pending plan").
 *
 * Scans for overdue open invoices and drafts one `send_reminder` plan
 * per uncovered invoice, each returned in `pending_approval`. The
 * endpoint only drafts — no reminder is sent until a drafted plan is
 * approved and executed through the ordinary gate, and an invoice
 * that was already reminded, or that a live/rejected/completed
 * reminder plan already covers, is reported in `skipped` instead of
 * being drafted twice.
 *
 * Body (all optional): { referenceDate?: "yyyy-mm-dd" } — the date the
 * overdue test is applied at; defaults to today (UTC).
 * 200 { referenceDate, overdueCount, drafted, skipped };
 * 400 on a malformed body or an invalid referenceDate.
 */
export async function POST(req: Request) {
  const { client, store } = getAgentRuntime();
  let body: Record<string, unknown> = {};
  const text = await req.text();
  if (text.trim()) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 });
    }
  }
  try {
    const referenceDate = resolveReferenceDate(body.referenceDate, new Date());
    const result = await suggestNextActions(client, store, { referenceDate });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SuggestionError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
