import { NextResponse } from "next/server";
import { BriefParseError, getAgentRuntime, parseBrief } from "@/lib/agent";

/** POST /api/agent/plan — NL brief → typed action plan (nothing executes). */
export async function POST(req: Request) {
  const { store } = getAgentRuntime();
  let body: { brief?: string };
  try {
    body = (await req.json()) as { brief?: string };
  } catch {
    return NextResponse.json({ error: "Request body must be JSON with a 'brief' string" }, { status: 400 });
  }
  if (!body.brief) {
    return NextResponse.json({ error: "Missing 'brief'" }, { status: 400 });
  }
  try {
    const plan = store.addPlan(parseBrief(body.brief));
    return NextResponse.json({ plan }, { status: 201 });
  } catch (err) {
    if (err instanceof BriefParseError) return NextResponse.json({ error: err.message }, { status: 422 });
    throw err;
  }
}

/** GET /api/agent/plan — list plans (console read model, v1). */
export async function GET() {
  const { store } = getAgentRuntime();
  return NextResponse.json({ plans: store.listPlans(), activity: store.listActivity() });
}
