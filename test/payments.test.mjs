import { beforeEach, describe, expect, it } from "vitest";
import { challenge, verifyTxHash } from "../worker/payments.mjs";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const USDC = "0x2222222222222222222222222222222222222222";
const PAYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function pad(addr) {
  return "0x000000000000000000000000" + addr.slice(2).toLowerCase();
}

function hexValue(units) {
  return "0x" + BigInt(units).toString(16);
}

function receipt({ to = PAY_TO, value = "750000", token = USDC, block = 1000, status = "0x1" } = {}) {
  return {
    status,
    blockNumber: "0x" + block.toString(16),
    logs: [
      {
        address: token,
        topics: [TRANSFER_TOPIC, pad(PAYER), pad(to)],
        data: hexValue(value),
        transactionHash: "0x" + "c".repeat(64),
      },
    ],
  };
}

function rpcResponds(result) {
  return async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

const RPC = "https://goat.rpc.test";
const ORDER = { payment: { startBlock: 500 } };

beforeEach(() => {
  globalThis.fetch = rpcResponds(receipt());
});

describe("challenge", () => {
  it("describes the GOAT USDC payment correctly", () => {
    const c = challenge();
    expect(c.x402Version).toBe(1);
    expect(c.accepts).toHaveLength(1);
    const a = c.accepts[0];
    expect(a.scheme).toBe("erc20-direct");
    expect(a.network).toBe("eip155:2345");
    expect(a.networkName).toBe("GOAT Mainnet");
    expect(a.token).toBe(USDC);
    expect(a.tokenSymbol).toBe("USDC");
    expect(a.decimals).toBe(6);
    expect(a.amount).toBe("750000"); // $0.75 at 6 decimals
    expect(a.amountHuman).toBe("0.75");
    expect(a.payTo).toBe(PAY_TO);
  });
});

describe("verifyTxHash", () => {
  it("accepts a matching successful USDC transfer", async () => {
    const v = await verifyTxHash("0x" + "c".repeat(64), ORDER, RPC);
    expect(v.ok).toBe(true);
    expect(v.from).toBe(PAYER);
    expect(v.amount).toBe("750000");
  });

  it("accepts overpayment but rejects underpayment", async () => {
    // overpayment
    globalThis.fetch = rpcResponds(receipt({ value: "1000000" }));
    const v1 = await verifyTxHash("0x" + "c".repeat(64), ORDER, RPC);
    expect(v1.ok).toBe(true);
    // underpayment
    globalThis.fetch = rpcResponds(receipt({ value: "700000" }));
    const v2 = await verifyTxHash("0x" + "c".repeat(64), ORDER, RPC);
    expect(v2.ok).toBe(false);
  });

  it("rejects the wrong recipient, wrong token, failed tx, and stale payments", async () => {
    // wrong recipient
    globalThis.fetch = rpcResponds(receipt({ to: OTHER }));
    expect((await verifyTxHash("0x" + "c".repeat(64), ORDER, RPC)).ok).toBe(false);
    // wrong token
    globalThis.fetch = rpcResponds(receipt({ token: OTHER }));
    expect((await verifyTxHash("0x" + "c".repeat(64), ORDER, RPC)).ok).toBe(false);
    // reverted tx
    globalThis.fetch = rpcResponds(receipt({ status: "0x0" }));
    expect((await verifyTxHash("0x" + "c".repeat(64), ORDER, RPC)).ok).toBe(false);
    // mined before the order existed
    globalThis.fetch = rpcResponds(receipt({ block: 100 }));
    expect((await verifyTxHash("0x" + "c".repeat(64), ORDER, RPC)).ok).toBe(false);
  });
});
