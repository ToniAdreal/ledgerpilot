import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { DraftValidationError, draftReminderPlan } from "@/lib/agent";

export const dynamic = "force-dynamic";

/**
 * POST /api/paypal/reminders — thin, validated wrapper over Invoicing
 * v2's remind endpoint (CONCEPT.md §3.1: the fourth typed action,
 * `send_reminder`). It drafts a `send_reminder` action plan and
 * returns it as `pending_approval`; NO reminder is sent until the
 * plan is approved and executed via /api/agent/approve +
 * /api/agent/execute. The approval gate has no REST back door.
 *
 * Body: { recipientName, recipientEmail?, invoiceRef? } → 201 { plan };
 * 400 on malformed JSON or any validation failure. Omit `invoiceRef`
 * to target the recipient's most-overdue open invoice at execution.
 */
export async function POST(req: Request) {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { store } = acquired.runtime;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be JSON reminder fields" }, { status: 400 });
  }
  try {
    const plan = store.addPlan(draftReminderPlan(body ?? {}));
    return NextResponse.json({ plan }, { status: 201 });
  } catch (err) {
    if (err instanceof DraftValidationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
