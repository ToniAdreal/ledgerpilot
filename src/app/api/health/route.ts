import { NextResponse } from "next/server";
import { buildHealthReport, healthHttpStatus } from "@/lib/health";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — deployment readiness report.
 *
 * Deliberately does NOT touch the agent runtime: the report is built
 * from the environment alone, so it can diagnose the exact case where
 * the runtime cannot be constructed (sandbox mode without credentials).
 * Carries booleans and missing-variable names only — never a secret.
 */
export async function GET() {
  const health = buildHealthReport(process.env);
  return NextResponse.json({ health }, { status: healthHttpStatus(health) });
}
