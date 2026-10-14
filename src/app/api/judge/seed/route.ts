import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { JudgeModeError, seedJudgeScenario } from "@/lib/judge";

export const dynamic = "force-dynamic";

/**
 * POST /api/judge/seed — load the Judge Mode demo scenario.
 * Idempotent: seeding an already-seeded runtime changes nothing and
 * returns `alreadySeeded: true` with the existing seed record.
 * Mock mode only: seeding creates the whole fictional history, so in
 * sandbox mode it refuses (409) before touching anything — the
 * history would otherwise be created at PayPal for fictional
 * recipients and strand half-written (see lib/judge/judge-mode.ts).
 */
export async function POST() {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { store, client } = acquired.runtime;
  try {
    const result = await seedJudgeScenario(client, store);
    return NextResponse.json({
      alreadySeeded: result.alreadySeeded,
      seed: result.seed,
      state: result.state,
    });
  } catch (err) {
    if (err instanceof JudgeModeError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
