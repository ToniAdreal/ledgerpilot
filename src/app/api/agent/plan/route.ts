import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { readJsonObjectBody } from "@/lib/api/body";
import { BriefParseError, parseBriefWithFallback } from "@/lib/agent";

/**
 * POST /api/agent/plan — NL brief → typed action plan (nothing executes).
 * Deterministic parser first; the optional LLM adapter (only when
 * LLM_API_KEY is configured) is a validated fallback — see lib/agent/llm.ts.
 */
export async function POST(req: Request) {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { store, llm } = acquired.runtime;
  const parsed = await readJsonObjectBody(req, "Request body must be JSON with a 'brief' string");
  if (parsed.response) return parsed.response;
  const { body } = parsed;
  if (typeof body.brief !== "string" || !body.brief) {
    return NextResponse.json({ error: "Missing 'brief'" }, { status: 400 });
  }
  try {
    const plan = store.addPlan(await parseBriefWithFallback(body.brief, { llm }));
    return NextResponse.json({ plan }, { status: 201 });
  } catch (err) {
    if (err instanceof BriefParseError) return NextResponse.json({ error: err.message }, { status: 422 });
    throw err;
  }
}

/** GET /api/agent/plan — list plans (console read model, v1). */
export async function GET() {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { store } = acquired.runtime;
  return NextResponse.json({ plans: store.listPlans(), activity: store.listActivity() });
}
