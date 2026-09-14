import { workerFetch } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Price discovery: GET /api/agent/v1/tiers */
export async function GET() {
  const { status, body } = await workerFetch("/v1/tiers");
  return Response.json(body, { status });
}
