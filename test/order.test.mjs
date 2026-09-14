import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { handler, pickOrderForPayment, store } from "../worker/worker.mjs";

/**
 * End-to-end order lifecycle through the worker's HTTP handler with every
 * network call stubbed: create -> pay (claim a tx hash) -> scan -> report.
 */

const PAY_TO = "0x1111111111111111111111111111111111111111";
const USDC = "0x2222222222222222222222222222222222222222";
const PAYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SCANNED = "0x" + "9f".repeat(20);
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CLAIM_TX = "0x" + "d".repeat(64);
const AGENT_TX = "0x" + "e".repeat(64);

function pad(addr) {
  return "0x000000000000000000000000" + addr.slice(2).toLowerCase();
}

function makeReq(method, path, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = path;
  req.headers = {}; // Node always provides a headers object; the handler reads it
  if (body !== undefined) {
    queueMicrotask(() => {
      req.emit("data", JSON.stringify(body));
      req.emit("end");
    });
  } else {
    queueMicrotask(() => req.emit("end"));
  }
  return req;
}

// handler(req, res) — build a tiny res that captures the response.
function call(method, path, body) {
  return callWithHeaders(method, path, body, {});
}

function callWithHeaders(method, path, body, extraHeaders) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      headers: {},
      body: "",
      writeHead(status, headers) {
        this.statusCode = status;
        this.headers = headers || {};
      },
      end(text) {
        this.body = text;
        resolve(res);
      },
    };
    const req = makeReq(method, path, body);
    for (const [k, v] of Object.entries(extraHeaders)) {
      req.headers = { ...(req.headers || {}), [k]: v };
    }
    handler(req, res);
  });
}

const json = (res) => JSON.parse(res.body);

// ---- RPC stubs ----
function chainRpcResult(method) {
  switch (method) {
    case "eth_blockNumber":
      return "0x1000";
    case "eth_getTransactionCount":
      return "0x12";
    case "eth_getBalance":
      return "0x" + (2n * 10n ** 18n).toString(16);
    case "eth_getCode":
      return "0x";
    case "eth_getLogs":
      return [
        {
          address: USDC,
          topics: [TRANSFER_TOPIC, pad(PAYER), pad(SCANNED)],
          data: "0x" + (10n ** 6n).toString(16),
          blockNumber: "0xff0",
          transactionHash: "0x" + "1".repeat(64),
        },
      ];
    case "eth_getBlockByNumber":
      return { timestamp: "0x" + Math.floor(Date.now() / 1000 - 86400 * 300).toString(16) };
    case "eth_getTransactionReceipt":
      return {
        status: "0x1",
        blockNumber: "0x1005",
        logs: [
          {
            address: USDC,
            topics: [TRANSFER_TOPIC, pad(PAYER), pad(PAY_TO)],
            data: "0x" + (750000n).toString(16),
            transactionHash: CLAIM_TX,
          },
        ],
      };
    default:
      return null;
  }
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const u = String(url);
      if (u.startsWith("https://verdict.test")) {
        // verdict endpoint down -> template fallback
        return new Response("nope", { status: 500 });
      }
      const body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: chainRpcResult(body.method) }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    })
  );
}

async function waitForOrderDone(orderId, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const res = await call("GET", `/order/${orderId}`);
    const body = json(res);
    if (body.status === "done") return body;
    if (Date.now() - start > timeoutMs) throw new Error("scan did not finish in time");
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe("order lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubFetch();
  });

  it("rejects a bad address", async () => {
    const res = await call("POST", "/order", { address: "not-an-address" });
    expect(res.statusCode).toBe(400);
  });

  it("creates an unpaid order with a 402 challenge and no report", async () => {
    const res = await call("POST", "/order", { address: SCANNED });
    expect(res.statusCode).toBe(201);
    const body = json(res);
    expect(body.status).toBe("awaiting_payment");
    expect(body.challenge.accepts[0].amount).toBe("750000");
    expect(body.challenge.accepts[0].payTo).toBe(PAY_TO);
    expect(body.report).toBeUndefined();
    expect(body.payment).toBeUndefined();

    // no report while unpaid
    const get = json(await call("GET", `/order/${body.orderId}`));
    expect(get.report).toBeUndefined();
  });

  it("full flow: claim a payment, scan runs, report publishes with all 12 bars", async () => {
    const created = json(await call("POST", "/order", { address: SCANNED }));
    const id = created.orderId;

    // wrong tx hash format
    const bad = await call("POST", `/order/${id}/claim`, { txHash: "0x123" });
    expect(bad.statusCode).toBe(400);

    // claim the payment with the GOAT transaction hash
    const claim = await call("POST", `/order/${id}/claim`, { txHash: CLAIM_TX });
    expect(claim.statusCode).toBe(200);
    const claimed = json(claim);
    expect(claimed.status).toBe("scanning");
    expect(claimed.payment.txHash).toBe(CLAIM_TX);

    // the same tx cannot pay for a second order
    const second = json(await call("POST", "/order", { address: SCANNED }));
    const reuse = await call("POST", `/order/${second.orderId}/claim`, { txHash: CLAIM_TX });
    expect(reuse.statusCode).toBe(409);

    // wait for the scan to finish
    const done = await waitForOrderDone(id);
    expect(done.report).toBeTruthy();
    expect(done.report.verdict.source).toBe("template");
    expect([
      "Do not interact",
      "Test with dust only",
      "OK for small, known use",
      "Not enough data",
    ]).toContain(done.report.verdict.verdict);
    expect(done.report.verdict.reasons).toHaveLength(3);
    expect(done.report.verdict.notChecked).toHaveLength(2);
    expect(done.report.barList).toHaveLength(12);
    expect(typeof done.report.overall).toBe("number");
    // agent identity present in the ERC-8004 format
    expect(done.report.agent.erc8004.agentRegistry).toMatch(/^eip155:2345:0x[0-9a-fA-F]{40}$/);
    expect(done.report.payment.txHash).toBe(CLAIM_TX);
    // every bar has a note
    expect(done.report.barList.every((b) => typeof b.note === "string")).toBe(true);
  });

  it("unknown order returns 404", async () => {
    const res = await call("GET", "/order/does_not_exist");
    expect(res.statusCode).toBe(404);
  });

  it("an incoming payment attaches to the newest unpaid order", () => {
    const mk = (id, createdAgoMs, status = "awaiting_payment") => ({
      id,
      createdAt: new Date(Date.now() - createdAgoMs).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      status,
      payment: { startBlock: 100 },
    });
    const oldest = mk("old", 60 * 60 * 1000);
    const newest = mk("new", 30 * 1000);
    const expired = mk("exp", 3 * 60 * 60 * 1000);
    expired.expiresAt = new Date(Date.now() - 1000).toISOString();
    const paid = mk("paid", 5 * 1000, "done");

    expect(pickOrderForPayment([oldest, newest])).toBe(newest);
    expect(pickOrderForPayment([oldest])).toBe(oldest);
    expect(pickOrderForPayment([expired, paid])).toBeNull();
    expect(pickOrderForPayment([])).toBeNull();
  });

  it("health endpoint reports the payment setup", async () => {
    const res = await call("GET", "/health");
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.payTo).toBe(PAY_TO);
    expect(body.priceUsd).toBe(0.75);
  });
});

describe("agent API (x402 pay-per-call)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubFetch();
  });

  it("POST /v1/scan without payment answers 402 with the x402 descriptor", async () => {
    const res = await call("POST", "/v1/scan", { address: SCANNED });
    expect(res.statusCode).toBe(402);
    expect(res.headers["WWW-Authenticate"] || res.headers["www-authenticate"]).toBe("x402");
    const body = json(res);
    expect(body.x402Version).toBe(1);
    expect(body.accepts[0]).toMatchObject({
      scheme: "erc20-direct",
      network: "eip155:2345",
      tokenSymbol: "USDC",
      amount: "750000",
      amountHuman: "0.75",
      payTo: PAY_TO,
    });
    expect(body.resource).toContain("POST /v1/scan");
    const orderHeader =
      res.headers["X-Order-Id"] ?? res.headers["x-order-id"];
    expect(typeof orderHeader).toBe("string");
  });

  it("GET /v1/scan is price discovery with the same 402 shape", async () => {
    const res = await call("GET", "/v1/scan");
    expect(res.statusCode).toBe(402);
    expect(json(res).accepts[0].amount).toBe("750000");
  });

  it("rejects a bad address before anything else", async () => {
    const res = await call("POST", "/v1/scan", { address: "nope" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a malformed X-Payment header", async () => {
    const res = await callWithHeaders("POST", "/v1/scan", { address: SCANNED }, {
      "x-payment": "not-a-hash",
    });
    expect(res.statusCode).toBe(400);
  });

  it("paid call with X-Payment starts the scan and returns a poll URL", async () => {
    const res = await callWithHeaders("POST", "/v1/scan", { address: SCANNED }, {
      "x-payment": AGENT_TX,
    });
    expect(res.statusCode).toBe(202);
    const body = json(res);
    expect(body.status).toBe("scanning");
    expect(body.poll).toMatch(/^\/v1\/report\//);

    // the same tx cannot pay twice
    const reuse = await callWithHeaders("POST", "/v1/scan", { address: SCANNED }, {
      "x-payment": AGENT_TX,
    });
    expect(reuse.statusCode).toBe(409);
  });

  it("GET /v1/tiers publishes the price and the agent identity", async () => {
    const res = await call("GET", "/v1/tiers");
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.tiers[0]).toMatchObject({
      name: "standard",
      priceUsd: 0.75,
      amount: "750000",
      token: "USDC",
      payTo: PAY_TO,
    });
    expect(body.agent.erc8004.agentRegistry).toMatch(/^eip155:2345:0x[0-9a-fA-F]{40}$/);
  });

  it("GET /v1/report/:id returns the agent report with goatTx and identity", async () => {
    const res1 = await callWithHeaders("POST", "/v1/scan", { address: SCANNED }, {
      "x-payment": AGENT_TX,
    });
    const { orderId } = json(res1);
    const done = await waitForOrderDone(orderId);

    const res = await call("GET", `/v1/report/${orderId}`);
    expect(res.statusCode).toBe(200);
    const report = json(res);
    expect(report.goatTx).toBe(AGENT_TX);
    expect(report.goatTxUrl).toContain("explorer.goat.network/tx/");
    expect(report.payment.txHash).toBe(AGENT_TX);
    expect(report.bars).toHaveLength(12);
    expect(["Do not interact", "Test with dust only", "OK for small, known use", "Not enough data"])
      .toContain(report.verdict.verdict);
    expect(report.agent.erc8004.agentRegistry).toMatch(/^eip155:2345:0x[0-9a-fA-F]{40}$/);
    expect("agentId" in report.agent.erc8004).toBe(true);
    void done;
  });

  it("GET /v1/agent returns the ERC-8004 identity block", async () => {
    const res = await call("GET", "/v1/agent");
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.erc8004.agentRegistry).toMatch(/^eip155:2345:/);
    expect(body.erc8004.agentURI).toContain("agent.json");
  });

  it("report endpoint 404s for unknown orders and 402s for unpaid ones", async () => {
    expect((await call("GET", "/v1/report/does_not_exist")).statusCode).toBe(404);
    const created = json(await call("POST", "/order", { address: SCANNED }));
    const res = await call("GET", `/v1/report/${created.orderId}`);
    expect(res.statusCode).toBe(402);
    expect(json(res).accepts[0].payTo).toBe(PAY_TO);
  });
});
