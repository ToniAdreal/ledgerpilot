import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { getJudgeScenario, getJudgeState } from "@/lib/judge";

export const dynamic = "force-dynamic";

/** GET /api/judge — the scenario script + whether it is seeded + live spine state. */
export async function GET() {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { store, client } = acquired.runtime;
  const state = await getJudgeState(store, client);
  return NextResponse.json({ scenario: getJudgeScenario(), state });
}
