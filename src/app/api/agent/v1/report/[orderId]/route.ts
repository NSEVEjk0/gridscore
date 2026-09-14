import { workerFetch } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Report retrieval: GET /api/agent/v1/report/[orderId] */
export async function GET(
  _req: Request,
  { params }: { params: { orderId: string } }
) {
  const { status, body } = await workerFetch(
    `/v1/report/${encodeURIComponent(params.orderId)}`
  );
  return Response.json(body, { status });
}
