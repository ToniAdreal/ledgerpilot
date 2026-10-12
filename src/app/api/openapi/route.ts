import { NextResponse } from "next/server";
import { buildOpenApiDocument } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * GET /api/openapi — the OpenAPI 3.1 document for this API.
 *
 * Built from the operation registry in src/lib/api/openapi.ts, whose
 * completeness the test suite enforces against the route files on
 * disk. Read-only; the document declares no host URL and no
 * credentials (servers is a single relative entry).
 */
export async function GET() {
  return NextResponse.json(buildOpenApiDocument());
}
