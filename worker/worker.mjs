import http from "node:http";
import { pathToFileURL } from "node:url";
import { AGENT, CHAINS, LIMITS, PAY, WORKER_BIND, WORKER_PORT, goatRpcs } from "./env.mjs";
import { rpcCall, scanAllChains } from "./chains.mjs";
import { computeBars } from "./score.mjs";
import { agentVerdict, templateVerdict } from "./verdict.mjs";
import { challenge, detectPayment, verifyTxHash } from "./payments.mjs";
import { Store, newOrderId } from "./state.mjs";

/**
 * Gridscore worker: order API + payment watcher + scan engine.
 *
 * Lifecycle of an order:
 *   awaiting_payment  -> 402 challenge active, watcher polls GOAT for USDC
 *   scanning          -> payment confirmed, chain scan + verdict running
 *                        (hard-capped at LIMITS.jobHardCapMs = 50s)
 *   done              -> report published (ready chains; the rest Unknown)
 *
 * A detected payment attaches to the NEWEST unpaid order — the one the
 * buyer's browser is most likely watching. The claim endpoint binds a
 * transaction hash to one specific order explicitly. Either way, each
 * transaction hash pays for exactly one scan.
 *
 * The whole job (RPCs + verdict + save) never exceeds the hard cap:
 * unfinished chains are published as Unknown.
 */

const ORDER_TTL_MS = 2 * 60 * 60 * 1000; // unpaid orders expire after 2h

const store = new Store();
const log = (event, data = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TXHASH_RE = /^0x[0-9a-fA-F]{64}$/;

async function currentGoatBlock() {
  const deadline = Date.now() + LIMITS.chainTimeoutMs;
  for (const url of goatRpcs()) {
    try {
      const n = await rpcCall(url, "eth_blockNumber", [], Math.max(500, deadline - Date.now()));
      return parseInt(n, 16);
    } catch {
      // try the next endpoint
    }
  }
  return null;
}

async function createOrder(address) {
  const startBlock = await currentGoatBlock();
  const order = {
    id: newOrderId(),
    address: address.toLowerCase(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ORDER_TTL_MS).toISOString(),
    status: "awaiting_payment",
    payment: {
      startBlock: startBlock ?? 0,
      paidAt: null,
      txHash: null,
      from: null,
      amountUnits: null,
    },
    scan: null,
    report: null,
  };
  store.put(order);
  log("order_created", { orderId: order.id, address: order.address });
  return order;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Which unpaid order should an incoming payment attach to? The newest one —
 * the page the buyer most likely has open right now.
 */
export function pickOrderForPayment(orders) {
  const unpaid = orders
    .filter((o) => o.status === "awaiting_payment" && Date.now() < Date.parse(o.expiresAt))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return unpaid[0] || null;
}

/** Fill in Unknown entries for chains that did not finish in time. */
function normalizeChainResults(results) {
  const byKey = new Map(results.map((r) => [r.chain, r]));
  return CHAINS.map(
    (c) =>
      byKey.get(c.key) || {
        status: "unknown",
        chain: c.key,
        chainName: c.name,
        chainId: c.chainId,
        reason: "job deadline reached",
      }
  );
}

export async function runScan(order) {
  const deadline = Date.now() + LIMITS.jobHardCapMs;
  order.status = "scanning";
  order.scan = { startedAt: new Date().toISOString() };
  store.put(order);
  log("scan_started", { orderId: order.id });

  const sink = [];
  const remaining = () => Math.max(0, deadline - Date.now());
  const chainTimeoutMs = Math.max(1000, Math.min(LIMITS.chainTimeoutMs, remaining()));

  const scanPromise = scanAllChains(CHAINS, order.address, {
    chainTimeoutMs,
    sink,
  });
  // Hard cap: never wait past the deadline for slow chains.
  await Promise.race([scanPromise, sleep(remaining())]);

  const chainResults = normalizeChainResults(sink);
  const score = computeBars(chainResults);

  // Verdict with whatever budget is left; the template path is instant.
  let verdict;
  if (remaining() > 2000) {
    verdict = await Promise.race([agentVerdict(score), sleep(remaining())]);
  }
  if (!verdict) {
    verdict = { ...templateVerdict(score), source: "template" };
  }

  order.report = {
    address: order.address,
    bars: score.bars,
    barList: Object.entries(score.bars).map(([key, b]) => ({
      key,
      score: b.score,
      note: b.note,
    })),
    overall: score.overall,
    meta: score.meta,
    verdict,
    agent: {
      name: "Gridscore screening agent",
      erc8004: {
        agentRegistry: AGENT.registry,
        agentId: AGENT.agentId,
        note: "ERC-8004 identity format per GOAT AgentKit; registry entry pending on-chain registration",
      },
    },
    payment: {
      network: "GOAT Mainnet (chain 2345)",
      token: "USDC",
      amountUsd: PAY.priceUsd,
      txHash: order.payment.txHash,
    },
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - (deadline - LIMITS.jobHardCapMs),
  };
  order.status = "done";
  store.put(order);
  log("scan_done", {
    orderId: order.id,
    overall: score.overall,
    verdict: verdict.verdict,
    verdictSource: verdict.source,
    reachableChains: score.meta.chainsReachable,
  });
}

async function markPaid(order, { txHash, from, amountUnits }) {
  if (order.status !== "awaiting_payment") return;
  order.payment.paidAt = new Date().toISOString();
  order.payment.txHash = txHash;
  order.payment.from = from;
  order.payment.amountUnits = amountUnits;
  store.put(order);
  log("payment_confirmed", { orderId: order.id, txHash });
  // Fire and forget — the client polls order status.
  runScan(order).catch((err) => {
    log("scan_error", { orderId: order.id, error: String(err && err.message || err) });
    order.status = "done";
    order.report = order.report || {
      overall: "unknown",
      verdict: {
        verdict: "Not enough data",
        reasons: ["The scan failed before any chain could be read"],
        notChecked: ["Everything — the scan errored"],
        source: "template",
      },
      bars: {},
      barList: [],
      meta: { chainsReachable: 0, chainsTotal: CHAINS.length, unknownChains: [], dataBars: 0 },
      payment: { txHash: order.payment.txHash },
      finishedAt: new Date().toISOString(),
    };
    store.put(order);
  });
}

// ---- Payment watcher: poll GOAT for incoming USDC on unpaid orders ----
async function watchPayments() {
  for (;;) {
    const target = pickOrderForPayment([...store.orders.values()]);
    if (target) {
      try {
        const txHash = await detectPayment(target, goatRpcs(), store.usedTxHashes, {
          chainTimeoutMs: LIMITS.chainTimeoutMs,
        });
        if (txHash) {
          const v = await verifyTxHash(txHash, target, goatRpcs(), {
            chainTimeoutMs: LIMITS.chainTimeoutMs,
          });
          if (v.ok) {
            await markPaid(target, { txHash, from: v.from, amountUnits: v.amount });
          } else {
            log("payment_rejected", { orderId: target.id, txHash, reason: v.reason });
          }
        }
      } catch {
        // transient RPC failure; try again next tick
      }
    }
    // Retire expired orders.
    for (const o of store.orders.values()) {
      if (o.status === "awaiting_payment" && Date.now() >= Date.parse(o.expiresAt)) {
        o.status = "expired";
        store.put(o);
        log("order_expired", { orderId: o.id });
      }
    }
    await sleep(LIMITS.watchPollMs);
  }
}

// ---- Public order view: no report before payment ----
function publicOrder(order) {
  const base = {
    orderId: order.id,
    address: order.address,
    status: order.status,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    challenge: challenge(),
    explorerTx: PAY.explorerTx,
  };
  if (order.status === "awaiting_payment" || order.status === "expired") {
    return base;
  }
  return {
    ...base,
    payment: {
      paidAt: order.payment.paidAt,
      txHash: order.payment.txHash,
      network: "GOAT Mainnet (chain 2345)",
      amountUsd: PAY.priceUsd,
    },
    scan: order.scan,
    report: order.status === "done" ? order.report : null,
  };
}

// ---- HTTP ----
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 64 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(text);
}

async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") return send(res, 200, { ok: true });

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, {
      ok: true,
      service: "gridscore-worker",
      payTo: PAY.payTo,
      priceUsd: PAY.priceUsd,
      orders: store.orders.size,
    });
  }

  if (req.method === "POST" && url.pathname === "/order") {
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
    const address = String(body.address || "").trim();
    if (!ADDRESS_RE.test(address)) {
      return send(res, 400, { error: "address must be a 0x address" });
    }
    const order = await createOrder(address);
    return send(res, 201, publicOrder(order));
  }

  const orderMatch = url.pathname.match(/^\/order\/([a-z0-9_]+)$/);
  if (req.method === "GET" && orderMatch) {
    const order = store.get(orderMatch[1]);
    if (!order) return send(res, 404, { error: "order not found" });
    return send(res, 200, publicOrder(order));
  }

  const claimMatch = url.pathname.match(/^\/order\/([a-z0-9_]+)\/claim$/);
  if (req.method === "POST" && claimMatch) {
    const order = store.get(claimMatch[1]);
    if (!order) return send(res, 404, { error: "order not found" });
    if (order.status === "expired") return send(res, 410, { error: "order expired" });
    if (order.status !== "awaiting_payment") {
      return send(res, 200, publicOrder(order));
    }
    let body;
    try {
      body = await readJson(req);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
    const txHash = String(body.txHash || "").trim();
    if (!TXHASH_RE.test(txHash)) {
      return send(res, 400, { error: "txHash must be a 0x transaction hash" });
    }
    const usedBy = [...store.orders.values()].find(
      (o) => o.payment?.txHash && o.payment.txHash.toLowerCase() === txHash.toLowerCase()
    );
    if (usedBy) {
      return send(res, 409, {
        error:
          "this transaction already paid for another scan on this page's payment address",
        usedByOrderId: usedBy.id,
        usedByStatus: usedBy.status,
      });
    }
    let v;
    try {
      v = await verifyTxHash(txHash, order, goatRpcs(), {
        chainTimeoutMs: LIMITS.chainTimeoutMs,
      });
    } catch (e) {
      return send(res, 502, { error: `could not verify on GOAT RPC: ${e.message}` });
    }
    if (!v.ok) {
      return send(res, 402, { error: v.reason, challenge: challenge() });
    }
    await markPaid(order, { txHash, from: v.from, amountUnits: v.amount });
    return send(res, 200, publicOrder(order));
  }

  return send(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  handler(req, res).catch((e) => {
    log("handler_error", { error: String(e && e.message || e) });
    send(res, 500, { error: "internal error" });
  });
});

function startWorker() {
  server.listen(WORKER_PORT, WORKER_BIND, () => {
    log("worker_started", { port: WORKER_PORT, bind: WORKER_BIND, payTo: PAY.payTo });
  });
  watchPayments().catch((e) => log("watcher_error", { error: String(e && e.message || e) }));
}

// Start only when run directly (worker.mjs is also imported by tests).
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startWorker();

export {
  handler,
  createOrder,
  markPaid,
  publicOrder,
  store,
  log as workerLog,
};
