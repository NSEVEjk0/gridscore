import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  createFlowOrder,
  flowConfigured,
  flowIsPaid,
  getFlowOrderStatus,
  signFlowParams,
} from "../worker/goatflow.mjs";

/**
 * The GOAT Flow x402 client: HMAC signing per the API reference, order
 * creation (HTTP 402 IS success), and status mapping. All HTTP mocked.
 */

const KEY = "test-flow-key";
const SECRET = "test-flow-secret";

describe("signFlowParams (HMAC per the Flow API reference)", () => {
  it("stringifies, adds key/timestamp/nonce, drops empties and sign, sorts, joins, HMACs", () => {
    // sorted key order: amount_wei, api_key, chain_id, dapp_order_id, nonce, timestamp, token_symbol
    const expected = createHmac("sha256", SECRET)
      .update("amount_wei=750000&api_key=" + KEY + "&chain_id=2345&dapp_order_id=gs_1&nonce=n1&timestamp=1000&token_symbol=USDC")
      .digest("hex");
    expect(
      signFlowParams(
        { dapp_order_id: "gs_1", chain_id: 2345, token_symbol: "USDC", from_address: "", amount_wei: "750000" },
        SECRET,
        "1000",
        "n1",
        KEY
      )
    ).toBe(expected);
  });

  it("drops the sign field and is deterministic for the same inputs", () => {
    const a = signFlowParams({ sign: "ignore-me", a: 1 }, SECRET, "t", "n", KEY);
    const b = signFlowParams({ a: 1 }, SECRET, "t", "n", KEY);
    expect(a).toBe(b);
  });
});

describe("Flow client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function enableFlow() {
    vi.stubEnv("GOATX402_API_KEY", KEY);
    vi.stubEnv("GOATX402_API_SECRET", SECRET);
  }

  it("is unconfigured without credentials", () => {
    expect(flowConfigured()).toBe(false);
  });

  it("createFlowOrder sends the documented fields with HMAC headers and accepts the 402 challenge", async () => {
    enableFlow();
    let captured;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        captured = { url: String(url), init };
        return new Response(
          JSON.stringify({
            x402Version: 2,
            order_id: "flow_123",
            accepts: [{ scheme: "erc20-direct", network: "eip155:2345", payTo: "0xpay" }],
          }),
          { status: 402, headers: { "Content-Type": "application/json" } }
        );
      })
    );
    const order = await createFlowOrder({ dappOrderId: "gs_test", fromAddress: "0xabc" });
    expect(order.orderId).toBe("flow_123");
    expect(order.challenge.x402Version).toBe(2);

    // request shape per the API reference
    expect(captured.url).toBe("https://flow-api.goat.network/api/v1/orders");
    const h = captured.init.headers;
    expect(h["X-API-Key"]).toBe(KEY);
    expect(h["X-Timestamp"]).toMatch(/^\d+$/);
    expect(h["X-Nonce"].length).toBeGreaterThan(10);
    expect(h["X-Sign"]).toMatch(/^[0-9a-f]{64}$/);
    const body = JSON.parse(captured.init.body);
    expect(body).toMatchObject({
      dapp_order_id: "gs_test",
      chain_id: 2345,
      token_symbol: "USDC",
      from_address: "0xabc",
      amount_wei: "750000",
    });
  });

  it("rejects a create-order response without an order id", async () => {
    enableFlow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 }))
    );
    await expect(createFlowOrder({ dappOrderId: "gs_x" })).rejects.toThrow(/failed \(500\)/);
  });

  it("getFlowOrderStatus maps the wire fields", async () => {
    enableFlow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: { order_id: "flow_123", status: "PAYMENT_CONFIRMED", tx_hash: "0xgoat", confirmed_at: "2026-09-14T00:00:00Z" },
          }),
          { status: 200 }
        )
      )
    );
    const state = await getFlowOrderStatus("flow_123");
    expect(state).toEqual({
      status: "PAYMENT_CONFIRMED",
      txHash: "0xgoat",
      confirmedAt: "2026-09-14T00:00:00Z",
    });
    expect(flowIsPaid(state.status)).toBe(true);
  });

  it("settled statuses are exactly PAYMENT_CONFIRMED and INVOICED", () => {
    expect(flowIsPaid("PAYMENT_CONFIRMED")).toBe(true);
    expect(flowIsPaid("INVOICED")).toBe(true);
    expect(flowIsPaid("CHECKOUT_VERIFIED")).toBe(false);
    expect(flowIsPaid("FAILED")).toBe(false);
    expect(flowIsPaid("EXPIRED")).toBe(false);
  });
});

describe("worker Flow integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("with Flow configured, an unpaid scan creates a Flow order and returns its 402 challenge", async () => {
    vi.stubEnv("GOATX402_API_KEY", KEY);
    vi.stubEnv("GOATX402_API_SECRET", SECRET);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const u = String(url);
        if (u.includes("flow-api") && u.endsWith("/api/v1/orders") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              x402Version: 2,
              order_id: "flow_abc",
              accepts: [{ scheme: "erc20-direct", network: "eip155:2345", payTo: "0xpay", amount: "750000" }],
            }),
            { status: 402 }
          );
        }
        // chain RPC stub for order creation (block number)
        const body = init?.body ? JSON.parse(init.body) : {};
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: "0x1000" }),
          { status: 200 }
        );
      })
    );
    const { handler } = await import("../worker/worker.mjs");
    const EventEmitter = (await import("node:events")).default;
    const res = await new Promise((resolve) => {
      const r = {
        statusCode: 0, headers: {}, body: "",
        writeHead(s, h) { this.statusCode = s; this.headers = h || {}; },
        end(t) { this.body = t; resolve(r); },
      };
      const req = new EventEmitter();
      req.method = "POST"; req.url = "/v1/scan"; req.headers = {};
      handler(req, r);
      queueMicrotask(() => { req.emit("data", JSON.stringify({ address: "0x" + "9f".repeat(20) })); req.emit("end"); });
    });
    expect(res.statusCode).toBe(402);
    const body = JSON.parse(res.body);
    expect(body.order_id).toBe("flow_abc");
    expect(body.x402Version).toBe(2);
    expect(res.headers["X-Order-Id"]).toMatch(/^gs_/);
  });

  it("a paid Flow order id in X-Payment settles the scan", async () => {
    vi.stubEnv("GOATX402_API_KEY", KEY);
    vi.stubEnv("GOATX402_API_SECRET", SECRET);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        const u = String(url);
        if (u.includes("flow-api") && u.includes("/api/v1/orders/flow_paid")) {
          return new Response(
            JSON.stringify({ data: { status: "PAYMENT_CONFIRMED", tx_hash: "0xflowtx", confirmed_at: "2026-09-14T00:00:00Z" } }),
            { status: 200 }
          );
        }
        const body = init?.body ? JSON.parse(init.body) : {};
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result: "0x1000" }),
          { status: 200 }
        );
      })
    );
    const { handler } = await import("../worker/worker.mjs");
    const EventEmitter = (await import("node:events")).default;
    const res = await new Promise((resolve) => {
      const r = {
        statusCode: 0, headers: {}, body: "",
        writeHead(s, h) { this.statusCode = s; this.headers = h || {}; },
        end(t) { this.body = t; resolve(r); },
      };
      const req = new EventEmitter();
      req.method = "POST"; req.url = "/v1/scan";
      req.headers = { "x-payment": "flow_paid" };
      handler(req, r);
      queueMicrotask(() => { req.emit("data", JSON.stringify({ address: "0x" + "9f".repeat(20) })); req.emit("end"); });
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("scanning");
    expect(body.poll).toMatch(/^\/v1\/report\//);
  });
});
