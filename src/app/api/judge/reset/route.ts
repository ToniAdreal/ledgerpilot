import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { JudgeModeError, resetJudgeDemo } from "@/lib/judge";

export const dynamic = "force-dynamic";

/**
 * POST /api/judge/reset — return a mock-mode demo instance to its
 * fresh slate (all plans, activity, and mock PayPal resources
 * cleared; the flagged sample dispute restored) so Judge Mode can be
 * seeded and run again by the next judge. Refuses (409) in sandbox
 * mode, where the resources live at PayPal and cannot be cleared.
 */
export async function POST() {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { store, client } = acquired.runtime;
  try {
    const result = await resetJudgeDemo(client, store);
    return NextResponse.json({ cleared: result.cleared, state: result.state });
  } catch (err) {
    if (err instanceof JudgeModeError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
