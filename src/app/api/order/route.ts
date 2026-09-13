import { workerFetch } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { status, body: workerBody } = await workerFetch("/order", {
    method: "POST",
    body: JSON.stringify({ address: body?.address }),
  });
  return Response.json(workerBody, { status });
}
