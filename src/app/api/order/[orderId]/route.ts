import { workerFetch } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { orderId: string } }
) {
  const { status, body } = await workerFetch(
    `/order/${encodeURIComponent(params.orderId)}`
  );
  return Response.json(body, { status });
}
