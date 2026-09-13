import { LIMITS } from "./env.mjs";

/**
 * Public RPC data collection for one address on one chain.
 *
 * Everything here is plain JSON-RPC over HTTPS. No indexer, no API keys.
 * Per-chain timeout is 8s -> the chain reports Unknown, never a fake 0.
 * Transfer/Approval logs are capped at LIMITS.maxTxsPerChain entries.
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

/**
 * Collect everything the 12 bars need for one chain.
 * Returns { status: "ok" | "unknown", ...data } — never throws.
 */
export async function scanChain(chain, address, opts = {}) {
  const timeoutMs = opts.chainTimeoutMs || LIMITS.chainTimeoutMs;
  const cap = opts.maxTxsPerChain || LIMITS.maxTxsPerChain;
  const rpc = chain.rpc;
  const addr = address.toLowerCase();

  try {
    // Baseline account state — all three in one Promise.all, sharing the timeout.
    const [nonce, balance, code, blockNumber] = await Promise.all([
      rpcCall(rpc, "eth_getTransactionCount", [address, "latest"], timeoutMs),
      rpcCall(rpc, "eth_getBalance", [address, "latest"], timeoutMs),
      rpcCall(rpc, "eth_getCode", [address, "latest"], timeoutMs),
      rpcCall(rpc, "eth_blockNumber", [], timeoutMs),
    ]);

    const headBlock = countToBucket(blockNumber);
    // Look back up to ~200k blocks (roughly a month on most chains) for logs.
    const fromBlock = Math.max(0, headBlock - 200_000);
    const fromBlockHex = "0x" + fromBlock.toString(16);

    // Token transfers involving the address, newest first, capped.
    const [sentLogs, recvLogs, approvalLogs] = await Promise.all([
      rpcCall(
        rpc,
        "eth_getLogs",
        [
          {
            fromBlock: fromBlockHex,
            toBlock: "latest",
            topics: [TRANSFER_TOPIC, padAddress(address)],
          },
        ],
        timeoutMs
      ).then((ls) => (Array.isArray(ls) ? ls.slice(0, cap) : [])),
      rpcCall(
        rpc,
        "eth_getLogs",
        [
          {
            fromBlock: fromBlockHex,
            toBlock: "latest",
            topics: [TRANSFER_TOPIC, null, padAddress(address)],
          },
        ],
        timeoutMs
      ).then((ls) => (Array.isArray(ls) ? ls.slice(0, cap) : [])),
      rpcCall(
        rpc,
        "eth_getLogs",
        [
          {
            fromBlock: fromBlockHex,
            toBlock: "latest",
            topics: [APPROVAL_TOPIC, padAddress(address)],
          },
        ],
        timeoutMs
      ).then((ls) => (Array.isArray(ls) ? ls.slice(0, cap) : [])),
    ]);

    // Timestamps for distinct blocks (capped to bound RPC calls).
    const blockNums = [
      ...new Set([...sentLogs, ...recvLogs].map((l) => l.blockNumber)),
    ].slice(0, 40);
    const timestamps = {};
    await Promise.all(
      blockNums.map(async (bn) => {
        try {
          const block = await rpcCall(rpc, "eth_getBlockByNumber", [bn, false], timeoutMs);
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
      reason: err && err.name === "AbortError" ? "timeout" : String(err && err.message || err).slice(0, 120),
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
