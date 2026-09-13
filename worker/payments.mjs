import { PAY, priceInUnits } from "./env.mjs";
import { TRANSFER_TOPIC, rpcCall } from "./chains.mjs";

/**
 * GOAT Network payment rails, x402-style: the order API answers with a 402
 * challenge describing an ERC-20 direct transfer (USDC on GOAT, chain 2345).
 * The buyer sends the transfer to payTo from any wallet; verification is
 * always against the GOAT RPC — the transaction hash is the receipt.
 */

function padAddress(address) {
  return "0x000000000000000000000000" + address.toLowerCase().slice(2);
}

/** The 402 payment challenge attached to every unpaid order. */
export function challenge() {
  const units = priceInUnits();
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "erc20-direct",
        network: `eip155:${PAY.chainId}`,
        networkName: "GOAT Mainnet",
        token: PAY.usdc,
        tokenSymbol: "USDC",
        decimals: PAY.usdcDecimals,
        amount: units,
        amountHuman: PAY.priceUsd.toFixed(2),
        payTo: PAY.payTo,
      },
    ],
    description: "Gridscore address screening report",
    resource: "/api/scan",
  };
}

function hexToBigint(hex) {
  try {
    return BigInt(hex);
  } catch {
    return 0n;
  }
}

function parseTransferLog(log) {
  if (!log || !Array.isArray(log.topics) || log.topics.length < 3) return null;
  if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC) return null;
  return {
    token: (log.address || "").toLowerCase(),
    from: "0x" + log.topics[1].slice(-40),
    to: "0x" + log.topics[2].slice(-40),
    value: hexToBigint(log.data === "0x" ? "0x0" : log.data),
  };
}

/**
 * Verify a claimed GOAT tx hash pays this order: a USDC transfer of at
 * least the price, to payTo, mined at or after the order was created.
 */
export async function verifyTxHash(txHash, order, rpcUrl, opts = {}) {
  const timeoutMs = opts.chainTimeoutMs;
  const receipt = await rpcCall(
    rpcUrl,
    "eth_getTransactionReceipt",
    [txHash],
    timeoutMs
  );
  if (!receipt || receipt.status !== "0x1") return { ok: false, reason: "not a successful transaction" };

  const need = BigInt(priceInUnits());
  const payTo = PAY.payTo;
  let paid = null;
  for (const log of receipt.logs || []) {
    const t = parseTransferLog(log);
    if (!t) continue;
    if (t.token !== PAY.usdc) continue;
    if (t.to !== payTo) continue;
    if (t.value < need) continue;
    paid = t;
    break;
  }
  if (!paid) return { ok: false, reason: "no matching USDC transfer to the payment address" };

  if (order.payment?.startBlock) {
    const block = parseInt(receipt.blockNumber, 16);
    if (block < order.payment.startBlock) {
      return { ok: false, reason: "payment is older than this order" };
    }
  }
  return { ok: true, txHash, from: paid.from, amount: paid.value.toString() };
}

/**
 * Look for any unclaimed incoming USDC payment to payTo since the order's
 * start block. Returns the first matching tx hash or null.
 */
export async function detectPayment(order, rpcUrl, usedTxHashes, opts = {}) {
  if (!order.payment?.startBlock) return null;
  const fromBlock = "0x" + order.payment.startBlock.toString(16);
  const logs = await rpcCall(
    rpcUrl,
    "eth_getLogs",
    [
      {
        fromBlock,
        toBlock: "latest",
        address: PAY.usdc,
        topics: [TRANSFER_TOPIC, null, padAddress(PAY.payTo)],
      },
    ],
    opts.chainTimeoutMs
  );
  if (!Array.isArray(logs)) return null;
  const need = BigInt(priceInUnits());
  for (const log of logs) {
    const t = parseTransferLog(log);
    if (!t || t.value < need) continue;
    const txHash = (log.transactionHash || "").toLowerCase();
    if (!txHash || usedTxHashes.has(txHash)) continue;
    return txHash;
  }
  return null;
}
