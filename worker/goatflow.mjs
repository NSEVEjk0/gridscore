import { createHmac, randomUUID } from "node:crypto";
import { flowConfig, PAY } from "./env.mjs";

/**
 * GOAT Flow x402 client — the official payment rails from the GOATNetwork/x402
 * API reference (https://github.com/GOATNetwork/x402):
 *
 *   POST /api/v1/orders                     -> 402 challenge (order created)
 *   GET  /api/v1/orders/{order_id}          -> order status
 *   GET  /api/v1/orders/{order_id}/proof    -> payment proof
 *
 * Auth is HMAC: X-API-Key, X-Timestamp, X-Nonce, X-Sign. Signing algorithm
 * per the reference: stringify body values, add api_key/timestamp/nonce,
 * drop `sign` and empty strings, sort keys, join `key=value&`, HMAC-SHA256
 * with the API secret, hex encode.
 *
 * Configure with GOATX402_API_URL / GOATX402_API_KEY / GOATX402_API_SECRET
 * (mainnet API: https://flow-api.goat.network). Without credentials the
 * worker falls back to the documented ERC20_DIRECT challenge and verifies
 * payments on-chain by GOAT transaction hash.
 */

export function flowConfigured() {
  const cfg = flowConfig();
  return Boolean(cfg.apiKey && cfg.apiSecret);
}

/** The HMAC signature per the Flow API reference. Exported for tests. */
export function signFlowParams(params, apiSecret, timestamp, nonce, apiKey) {
  const flat = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (k === "sign") continue;
    const s = String(v ?? "");
    if (s === "") continue;
    flat[k] = s;
  }
  if (apiKey) flat.api_key = apiKey;
  flat.timestamp = timestamp;
  flat.nonce = nonce;
  const payload = Object.keys(flat)
    .sort()
    .map((k) => `${k}=${flat[k]}`)
    .join("&");
  return createHmac("sha256", apiSecret).update(payload).digest("hex");
}

function flowHeaders(body) {
  const cfg = flowConfig();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-API-Key": cfg.apiKey,
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Sign": signFlowParams(body || {}, cfg.apiSecret, timestamp, nonce, cfg.apiKey),
  };
}

async function flowCall(method, path, body = null) {
  const cfg = flowConfig();
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: flowHeaders(body),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12_000),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

/**
 * Create an official Flow order for one scan. The documented success status
 * for order creation IS HTTP 402 — the challenge body is the payment
 * description the payer needs.
 */
export async function createFlowOrder(input) {
  const { status, body } = await flowCall("POST", "/api/v1/orders", {
    dapp_order_id: input.dappOrderId,
    chain_id: PAY.chainId,
    token_symbol: "USDC",
    from_address: input.fromAddress || "",
    amount_wei: BigInt(Math.round(PAY.priceUsd * 10 ** PAY.usdcDecimals)).toString(),
  });
  if (status !== 402 && status !== 200 && status !== 201) {
    throw new Error(
      `Flow create-order failed (${status}): ${JSON.stringify(body).slice(0, 200)}`
    );
  }
  const orderId = body?.order_id ?? body?.orderId ?? body?.data?.order_id;
  if (!orderId) {
    throw new Error("Flow create-order returned no order_id");
  }
  return { orderId: String(orderId), challenge: body };
}

export async function getFlowOrderStatus(orderId) {
  const { status, body } = await flowCall("GET", `/api/v1/orders/${encodeURIComponent(orderId)}`);
  if (status !== 200) {
    throw new Error(`Flow order-status failed (${status})`);
  }
  const d = body?.data ?? body;
  return {
    status: String(d?.status ?? "UNKNOWN"),
    txHash: d?.tx_hash ?? d?.txHash ?? null,
    confirmedAt: d?.confirmed_at ?? d?.confirmedAt ?? null,
  };
}

/** A Flow order is settled when payment is confirmed or invoiced. */
export function flowIsPaid(status) {
  return status === "PAYMENT_CONFIRMED" || status === "INVOICED";
}
