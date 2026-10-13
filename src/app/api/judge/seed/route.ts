import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { seedJudgeScenario } from "@/lib/judge";

export const dynamic = "force-dynamic";

/**
 * POST /api/judge/seed — load the Judge Mode demo scenario.
 * Idempotent: seeding an already-seeded runtime changes nothing and
 * returns `alreadySeeded: true` with the existing seed record.
 */
export async function POST() {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { store, client } = acquired.runtime;
  const result = await seedJudgeScenario(client, store);
  return NextResponse.json({
    alreadySeeded: result.alreadySeeded,
    seed: result.seed,
    state: result.state,
  });
}
