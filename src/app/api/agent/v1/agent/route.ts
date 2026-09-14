import { workerFetch } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The agent's ERC-8004 identity: GET /api/agent/v1/agent */
export async function GET() {
  const { status, body } = await workerFetch("/v1/agent");
  return Response.json(body, { status });
}
