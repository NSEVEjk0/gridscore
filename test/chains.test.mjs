import { describe, expect, it, vi } from "vitest";
import { scanChain, scanAllChains, tryRpc } from "../worker/chains.mjs";

const ADDR = "0x" + "9f".repeat(20);
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const GOAT = { key: "goat", name: "GOAT", chainId: 2345, rpcs: ["https://goat.rpc.test"] };
const ETH = {
  key: "ethereum",
  name: "Ethereum",
  chainId: 1,
  rpcs: ["https://eth1.rpc.test", "https://eth2.rpc.test"],
};

function pad(addr) {
  return "0x000000000000000000000000" + addr.slice(2).toLowerCase();
}

function rpcResult(method, params) {
  switch (method) {
    case "eth_blockNumber":
      return "0x100000";
    case "eth_getTransactionCount":
      return "0x9";
    case "eth_getBalance":
      return "0x" + (5n * 10n ** 17n).toString(16);
    case "eth_getCode":
      return "0x";
    case "eth_getLogs": {
      // return 300 transfer logs when asked for transfers from the address
      const topics = params[0].topics;
      if (topics[1] && topics[1].toLowerCase() === pad(ADDR)) {
        return Array.from({ length: 300 }, (_, i) => ({
          address: "0x" + (i % 5).toString().repeat(40),
          topics: [TRANSFER_TOPIC, pad(ADDR), pad("0x" + "bb".repeat(20))],
          data: "0x" + (10n ** 15n).toString(16),
          blockNumber: "0x" + (0xf0000 + i).toString(16),
          transactionHash: "0x" + i.toString(16).padStart(64, "0"),
        }));
      }
      return [];
    }
    case "eth_getBlockByNumber":
      return { timestamp: "0x" + Math.floor(Date.now() / 1000 - 86400 * 10).toString(16) };
    default:
      return null;
  }
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: rpcResult(body.method, body.params) }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    })
  );
}

describe("tryRpc endpoint fallback", () => {
  it("falls through to the next endpoint when the first fails", async () => {
    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        calls.push(String(url));
        if (String(url).includes("eth1")) {
          return new Response("down", { status: 503 });
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    const out = await tryRpc(ETH.rpcs, "eth_blockNumber", [], Date.now() + 5000);
    expect(out).toBe("0x1");
    expect(calls).toEqual(["https://eth1.rpc.test", "https://eth2.rpc.test"]);
  });

  it("gives up when every endpoint fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 }))
    );
    await expect(
      tryRpc(ETH.rpcs, "eth_blockNumber", [], Date.now() + 5000)
    ).rejects.toThrow();
  });

  it("respects the deadline and stops trying further endpoints", async () => {
    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (url, init) =>
          new Promise((_resolve, reject) => {
            calls.push(String(url));
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("This operation was aborted", "AbortError"))
            );
          })
      )
    );
    await expect(
      tryRpc(ETH.rpcs, "eth_blockNumber", [], Date.now() + 400)
    ).rejects.toThrow();
    // budget exhausted by the first hanging endpoint — no second call
    expect(calls).toEqual(["https://eth1.rpc.test"]);
  });
});

describe("scanChain", () => {
  it("collects account state and caps transfer logs at the limit", async () => {
    stubFetch();
    const r = await scanChain(GOAT, ADDR, { maxTxsPerChain: 200, chainTimeoutMs: 3000 });
    expect(r.status).toBe("ok");
    expect(r.nonce).toBe(9);
    expect(r.balance).toBeCloseTo(0.5, 5);
    expect(r.isContract).toBe(false);
    expect(r.transfersOut).toBe(200); // 300 available, capped at 200
    expect(r.capped).toBe(true);
    expect(r.transfersIn).toBe(0);
  });

  it("times out to Unknown, not zero, with a fast timeout", async () => {
    vi.stubGlobal(
      "fetch",
      // never resolves on its own; only the abort signal ends it, like a real fetch
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("This operation was aborted", "AbortError"))
            );
          })
      )
    );
    const r = await scanChain(ETH, ADDR, { chainTimeoutMs: 60 });
    expect(r.status).toBe("unknown");
    expect(r.reason).toBe("timeout");
    // no numeric data leaks through on a timeout
    expect(r.nonce).toBeUndefined();
  });

  it("an HTTP error also yields Unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("err", { status: 503 }))
    );
    const r = await scanChain(ETH, ADDR, { chainTimeoutMs: 500 });
    expect(r.status).toBe("unknown");
  });
});

describe("scanAllChains", () => {
  it("runs every chain and never rejects, filling the sink as it goes", async () => {
    stubFetch();
    const chains = Array.from({ length: 8 }, (_, i) => ({
      key: `c${i}`,
      name: `C${i}`,
      chainId: 1000 + i,
      rpc: "https://goat.rpc.test",
    }));
    const sink = [];
    const results = await scanAllChains(chains, ADDR, {
      maxTxsPerChain: 200,
      chainTimeoutMs: 3000,
      maxChainConcurrency: 4,
      sink,
    });
    expect(results).toHaveLength(8);
    expect(sink).toHaveLength(8);
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });
});
