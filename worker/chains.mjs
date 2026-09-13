import { LIMITS } from "./env.mjs";

/**
 * Public RPC data collection for one address on one chain.
 *
 * Everything here is plain JSON-RPC over HTTPS. No indexer, no API keys.
 * Each chain gets a total budget (default 8s) shared across all its calls;
 * if the budget runs out — or every endpoint fails — the chain reports
 * Unknown, never a fake 0. Each chain lists fallback endpoints and the
 * caller tries them in order. Transfer/Approval logs are capped at
 * LIMITS.maxTxsPerChain entries.
 */

export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const APPROVAL_TOPIC =
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

function padAddress(address) {
  return "0x000000000000000000000000" + address.toLowerCase().slice(2);
}

let rpcId = 1;

export async function rpcCall(url, method, params, timeoutMs = LIMITS.chainTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`rpc http ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`rpc error: ${body.error.message || body.error.code}`);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call a JSON-RPC method against a list of endpoints, trying them in order
 * until one answers. `deadline` is an absolute timestamp (Date.now()+budget):
 * every attempt gets whatever budget is left, so the total stays bounded.
 */
export async function tryRpc(rpcs, method, params, deadline, perAttemptCapMs = 8000) {
  let lastErr = new Error("no rpc endpoints");
  for (const url of rpcs) {
    const remaining = deadline - Date.now();
    if (remaining < 200) throw new Error("rpc budget exhausted");
    try {
      return await rpcCall(url, method, params, Math.min(remaining, perAttemptCapMs));
    } catch (err) {
      lastErr = err;
      if (err && err.name === "AbortError") {
        // The budget was consumed by this endpoint; no point trying the next.
        throw new Error("rpc budget exhausted");
      }
    }
  }
  throw lastErr;
}

function countToBucket(hexOrNumber) {
  const n = typeof hexOrNumber === "string" ? parseInt(hexOrNumber, 16) : Number(hexOrNumber || 0);
  return Number.isFinite(n) ? n : 0;
}

function weiToEther(hexOrNumber) {
  const n = typeof hexOrNumber === "string" && hexOrNumber.startsWith("0x")
    ? BigInt(hexOrNumber)
    : BigInt(Math.trunc(Number(hexOrNumber || 0)));
  // Format with 6 decimals, as a Number (loses dust precision, fine for rules).
  return Number(n) / 1e18;
}

const RANGE_ERR = /range|too large|too many|413|limit|maximum/i;
const LOG_CHUNK_START = 2000;
const LOG_CHUNK_MIN = 50;
const MAX_LOG_CALLS = 90;

function hexBlock(n) {
  return "0x" + n.toString(16);
}

/**
 * Walk eth_getLogs backward from the chain head in chunks. Public RPCs cap
 * the block range per call (2048 on some chains, 50 on others), so the chunk
 * size halves and retries when a range is rejected. The walk stops at the
 * transaction cap, the call cap, or when the chain's time budget runs out —
 * whichever comes first. Returns newest chunks first.
 */
async function fetchLogsBackward(rpc, deadline, headBlock, cap, padAddr) {
  const sent = [];
  const recv = [];
  const approvals = [];
  let chunk = LOG_CHUNK_START;
  let to = headBlock;
  let calls = 0;
  let halvings = 0;

  while (to > 0 && calls < MAX_LOG_CALLS && sent.length + recv.length < cap) {
    if (deadline - Date.now() < 400) break;
    const from = Math.max(0, to - chunk + 1);
    const range = { fromBlock: hexBlock(from), toBlock: hexBlock(to) };
    try {
      const [s, r, a] = await Promise.all([
        rpc("eth_getLogs", [
          { ...range, topics: [TRANSFER_TOPIC, padAddr, null] },
        ]),
        rpc("eth_getLogs", [
          { ...range, topics: [TRANSFER_TOPIC, null, padAddr] },
        ]),
        rpc("eth_getLogs", [
          { ...range, topics: [APPROVAL_TOPIC, padAddr] },
        ]),
      ]);
      calls += 3;
      if (Array.isArray(s)) sent.push(...s);
      if (Array.isArray(r)) recv.push(...r);
      if (Array.isArray(a)) approvals.push(...a);
      to = from - 1;
    } catch (err) {
      calls += 3;
      const msg = String(err && err.message || err);
      if (chunk > LOG_CHUNK_MIN && RANGE_ERR.test(msg) && halvings < 8) {
        halvings += 1;
        chunk = Math.max(LOG_CHUNK_MIN, Math.floor(chunk / 8));
        continue; // retry the same range with a smaller chunk
      }
      break; // keep whatever was collected
    }
  }
  return {
    sent: sent.slice(0, cap),
    recv: recv.slice(0, cap),
    approvals: approvals.slice(0, cap),
  };
}

/**
 * Collect everything the 12 bars need for one chain, within one shared
 * time budget. Returns { status: "ok" | "unknown", ...data } — never throws.
 */
export async function scanChain(chain, address, opts = {}) {
  const budgetMs = opts.chainTimeoutMs || LIMITS.chainTimeoutMs;
  const cap = opts.maxTxsPerChain || LIMITS.maxTxsPerChain;
  const rpcs = chain.rpcs || (chain.rpc ? [chain.rpc] : []);
  const deadline = Date.now() + budgetMs;
  const rpc = (method, params) => tryRpc(rpcs, method, params, deadline);
  const addr = address.toLowerCase();
  const padAddr = padAddress(address);

  try {
    // Baseline account state — all at once, sharing the budget.
    const [nonce, balance, code, blockNumber] = await Promise.all([
      rpc("eth_getTransactionCount", [address, "latest"]),
      rpc("eth_getBalance", [address, "latest"]),
      rpc("eth_getCode", [address, "latest"]),
      rpc("eth_blockNumber", []),
    ]);

    const headBlock = countToBucket(blockNumber);
    const { sent: sentLogs, recv: recvLogs, approvals: approvalLogs } =
      await fetchLogsBackward(rpc, deadline, headBlock, cap, padAddr);

    // Timestamps for distinct blocks (capped to bound RPC calls).
    const blockNums = [
      ...new Set([...sentLogs, ...recvLogs].map((l) => l.blockNumber)),
    ].slice(0, 40);
    const timestamps = {};
    await Promise.all(
      blockNums.map(async (bn) => {
        try {
          const block = await rpc("eth_getBlockByNumber", [bn, false]);
          if (block && block.timestamp) timestamps[bn] = Number(block.timestamp) * 1000;
        } catch {
          // missing timestamp for one block is fine
        }
      })
    );

    const tokens = new Set();
    const counterparties = new Set();
    const transferTimes = [];
    let oldestTs = null;
    let newestTs = null;

    const addTransfer = (log, direction) => {
      const other =
        direction === "out" ? log.topics[2] : log.topics[1];
      if (other) counterparties.add(other.toLowerCase());
      tokens.add(log.address.toLowerCase());
      const ts = timestamps[log.blockNumber];
      if (ts) {
        transferTimes.push(ts);
        if (oldestTs === null || ts < oldestTs) oldestTs = ts;
        if (newestTs === null || ts > newestTs) newestTs = ts;
      }
    };
    sentLogs.forEach((l) => addTransfer(l, "out"));
    recvLogs.forEach((l) => addTransfer(l, "in"));

    const approvalSpenders = new Set(
      approvalLogs.map((l) => (l.topics[2] || "").toLowerCase()).filter(Boolean)
    );

    return {
      status: "ok",
      chain: chain.key,
      chainName: chain.name,
      chainId: chain.chainId,
      nonce: countToBucket(nonce),
      balance: weiToEther(balance),
      isContract: typeof code === "string" && code.length > 2,
      transfersOut: sentLogs.length,
      transfersIn: recvLogs.length,
      distinctTokens: tokens.size,
      counterparties: counterparties.size,
      approvals: approvalLogs.length,
      approvalSpenders: approvalSpenders.size,
      transferTimes,
      oldestActivityMs: oldestTs,
      newestActivityMs: newestTs,
      examined: sentLogs.length + recvLogs.length,
      capped: sentLogs.length >= cap || recvLogs.length >= cap,
    };
  } catch (err) {
    return {
      status: "unknown",
      chain: chain.key,
      chainName: chain.name,
      chainId: chain.chainId,
      reason:
        err && /budget/.test(String(err.message))
          ? "timeout"
          : String(err && err.message || err).slice(0, 120),
    };
  }
}

/** Run all chains with bounded concurrency. Never rejects.
 *  opts.sink: array that receives each result as soon as it completes,
 *  so a caller racing a deadline can read partial results. */
export async function scanAllChains(chains, address, opts = {}) {
  const limit = opts.maxChainConcurrency || LIMITS.maxChainConcurrency;
  const results = opts.sink || [];
  const queue = [...chains];
  async function runNext() {
    while (queue.length > 0) {
      const chain = queue.shift();
      results.push(await scanChain(chain, address, opts));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, chains.length) }, runNext));
  return results;
}
