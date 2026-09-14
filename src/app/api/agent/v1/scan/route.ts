import { workerFetch } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent API surface on the web domain: POST /api/agent/v1/scan.
 * Unpaid -> 402 with the x402 descriptor. Paid (X-Payment: GOAT tx hash)
 * -> 202 with an order id to poll. The 402 status passes through verbatim.
 */
export async function POST(req: Request) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const payment = req.headers.get("x-payment");
  if (payment) headers["X-Payment"] = payment;

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { status, body: workerBody } = await workerFetch("/v1/scan", {
    method: "POST",
    headers,
    body: JSON.stringify({ address: body?.address }),
  });
  return Response.json(workerBody, { status });
}

export async function GET() {
  const { status, body } = await workerFetch("/v1/scan", { method: "GET" });
  return Response.json(body, { status });
}
