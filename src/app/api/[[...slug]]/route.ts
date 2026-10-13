import { unknownApiRouteResponse } from "@/lib/api/unknown-route";

export const dynamic = "force-dynamic";

/**
 * Catch-all for unknown paths under `/api/` — every method answers
 * the JSON 404 from `src/lib/api/unknown-route.ts` (the API's shared
 * `{ error }` shape), never the page-level HTML not-found. Concrete
 * route files take precedence over this optional catch-all, so it
 * only ever sees paths no route implements; it deliberately builds
 * no runtime, so unknown paths answer 404 even on a misconfigured
 * instance whose implemented routes answer 503.
 */
type Context = { params: Promise<{ slug?: string[] }> };

async function unknown(_request: Request, { params }: Context) {
  const { slug } = await params;
  return unknownApiRouteResponse(slug);
}

export const GET = unknown;
export const POST = unknown;
export const PUT = unknown;
export const PATCH = unknown;
export const DELETE = unknown;
