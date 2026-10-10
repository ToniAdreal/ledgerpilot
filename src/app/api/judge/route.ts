import { NextResponse } from "next/server";
import { getAgentRuntime } from "@/lib/agent";
import { getJudgeScenario, getJudgeState } from "@/lib/judge";

export const dynamic = "force-dynamic";

/** GET /api/judge — the scenario script + whether it is seeded + live spine state. */
export async function GET() {
  const { store, client } = getAgentRuntime();
  const state = await getJudgeState(store, client);
  return NextResponse.json({ scenario: getJudgeScenario(), state });
}
