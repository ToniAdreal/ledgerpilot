import { NextResponse } from "next/server";
import { acquireRuntime } from "@/lib/api/errors";
import { ToolCallError, listAgentTools, toolCallsToPlan } from "@/lib/agent";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent/tools — the agent's tool definitions in MCP /
 * Agent Toolkit shape ({ name, description, inputSchema } per tool):
 * the discovery surface for tool-calling clients. Read-only.
 */
export async function GET() {
  return NextResponse.json({ tools: listAgentTools() });
}

/**
 * POST /api/agent/tools — tool-call-shaped plan drafting (CONCEPT.md
 * §1's stretch goal: the agent's action layer as tool definitions).
 * Body is either one call — { name, arguments } — or a sequence —
 * { calls: [{ name, arguments }, …], brief? }. The calls are validated
 * in code and converted into a typed `pending_approval` plan
 * (`source: "tool"`); NO PayPal call happens until the plan is
 * approved and executed via /api/agent/approve + /api/agent/execute.
 * The approval gate has no tool-call back door.
 * → 201 { plan }; 400 on malformed JSON or any validation failure.
 */
export async function POST(req: Request) {
  const acquired = acquireRuntime();
  if (acquired.response) return acquired.response;
  const { store } = acquired.runtime;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be JSON: { name, arguments } or { calls: [...] }" }, { status: 400 });
  }
  try {
    const calls = Array.isArray(body?.calls) ? body.calls : [body];
    const brief = typeof body?.brief === "string" && body.brief.trim() ? body.brief : undefined;
    const plan = store.addPlan(toolCallsToPlan(calls, brief ? { brief } : {}));
    return NextResponse.json({ plan }, { status: 201 });
  } catch (err) {
    if (err instanceof ToolCallError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
