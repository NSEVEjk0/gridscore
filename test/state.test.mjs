import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, newOrderId } from "../worker/state.mjs";

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gridscore-state-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function order(id, payment = {}) {
  return {
    id,
    address: "0x" + "ab".repeat(20),
    createdAt: new Date().toISOString(),
    status: "awaiting_payment",
    payment: { startBlock: 100, paidAt: null, txHash: null, from: null, amountUnits: null, ...payment },
  };
}

describe("Store", () => {
  it("puts and gets orders", () => {
    const s = new Store(join(dir, "state.jsonl"));
    const o = order(newOrderId());
    s.put(o);
    expect(s.get(o.id)).toEqual(o);
    expect(s.get("missing")).toBeNull();
  });

  it("tracks used transaction hashes", () => {
    const s = new Store(join(dir, "state.jsonl"));
    const o = order(newOrderId(), { txHash: "0x" + "a".repeat(64) });
    s.put(o);
    expect(s.txUsed("0x" + "A".repeat(64))).toBe(true); // case-insensitive
    expect(s.txUsed("0x" + "b".repeat(64))).toBe(false);
  });

  it("replays state from disk after a restart", () => {
    const path = join(dir, "state.jsonl");
    const s1 = new Store(path);
    const o = order(newOrderId(), { txHash: "0x" + "c".repeat(64) });
    s1.put(o);
    s1.put({ ...o, status: "done" });

    const s2 = new Store(path); // "restart"
    expect(s2.get(o.id).status).toBe("done"); // later line wins
    expect(s2.txUsed("0x" + "c".repeat(64))).toBe(true);
  });

  it("skips corrupt lines on replay", () => {
    const path = join(dir, "state.jsonl");
    const s1 = new Store(path);
    const o = order(newOrderId());
    s1.put(o);
    appendFileSync(path, "not json\n");
    const s2 = new Store(path);
    expect(s2.get(o.id)).toEqual(o);
  });
});
