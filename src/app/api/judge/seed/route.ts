import { NextResponse } from "next/server";
import { getAgentRuntime } from "@/lib/agent";
import { seedJudgeScenario } from "@/lib/judge";

export const dynamic = "force-dynamic";

/**
 * POST /api/judge/seed — load the Judge Mode demo scenario.
 * Idempotent: seeding an already-seeded runtime changes nothing and
 * returns `alreadySeeded: true` with the existing seed record.
 */
export async function POST() {
  const { store, client } = getAgentRuntime();
  const result = await seedJudgeScenario(client, store);
  return NextResponse.json({
    alreadySeeded: result.alreadySeeded,
    seed: result.seed,
    state: result.state,
  });
}
