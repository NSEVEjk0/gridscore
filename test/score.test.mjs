import { describe, expect, it } from "vitest";
import { computeBars, barList, BAR_DEFS } from "../worker/score.mjs";

const NOW = 1_750_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function okChain(overrides = {}) {
  return {
    status: "ok",
    chain: "goat",
    chainName: "GOAT",
    chainId: 2345,
    nonce: 3,
    balance: 0.5,
    isContract: false,
    transfersOut: 2,
    transfersIn: 4,
    distinctTokens: 3,
    counterparties: 6,
    approvals: 1,
    approvalSpenders: 1,
    transferTimes: [NOW - 10 * DAY, NOW - 5 * DAY, NOW - 1 * DAY],
    oldestActivityMs: NOW - 400 * DAY,
    newestActivityMs: NOW - 1 * DAY,
    examined: 6,
    capped: false,
    ...overrides,
  };
}

describe("computeBars", () => {
  it("produces all 12 bars with a numeric overall averaging scored bars only", () => {
    const score = computeBars([okChain()], NOW);
    expect(Object.keys(score.bars).sort()).toEqual(
      BAR_DEFS.map((d) => d.key).sort()
    );

    // numeric bars only in the average
    const numeric = Object.values(score.bars)
      .map((b) => b.score)
      .filter((s) => typeof s === "number");
    const expected = Math.round(numeric.reduce((a, b) => a + b, 0) / numeric.length);
    expect(score.overall).toBe(expected);

    // failed txs and labels are not numeric
    expect(score.bars.failed.score).toBe("unknown");
    expect(score.bars.labels.score).toBe("na");
  });

  it("an unreachable chain is Unknown, never a zero", () => {
    const score = computeBars(
      [{ status: "unknown", chain: "goat", chainName: "GOAT", chainId: 2345, reason: "timeout" }],
      NOW
    );
    expect(score.bars.presence.score).toBe("unknown");
    expect(score.bars.activity.score).toBe("unknown");
    expect(score.overall).toBe("unknown");
    expect(score.meta.unknownChains).toEqual(["GOAT"]);
    expect(score.meta.chainsReachable).toBe(0);
  });

  it("mixed reachability: unknown chains do not drag the average down", () => {
    const only = computeBars([okChain()], NOW);
    const mixed = computeBars(
      [
        okChain(),
        { status: "unknown", chain: "ethereum", chainName: "Ethereum", chainId: 1, reason: "timeout" },
      ],
      NOW
    );
    expect(mixed.overall).toBe(only.overall);
    expect(mixed.meta.chainsReachable).toBe(1);
    expect(mixed.meta.unknownChains).toEqual(["Ethereum"]);
  });

  it("old accounts score higher on age than fresh ones", () => {
    const fresh = computeBars([okChain({ oldestActivityMs: NOW - 2 * DAY })], NOW);
    const old = computeBars([okChain({ oldestActivityMs: NOW - 900 * DAY })], NOW);
    expect(old.bars.age.score).toBeGreaterThan(fresh.bars.age.score);
    // no dated activity at all -> Unknown age
    const none = computeBars([okChain({ oldestActivityMs: null })], NOW);
    expect(none.bars.age.score).toBe("unknown");
  });

  it("contract accounts and heavy approvals score lower", () => {
    const eoa = computeBars([okChain()], NOW);
    const contract = computeBars([okChain({ isContract: true })], NOW);
    expect(contract.bars.contract.score).toBeLessThan(eoa.bars.contract.score);

    const heavy = computeBars([okChain({ approvals: 40 })], NOW);
    expect(heavy.bars.approvals.score).toBeLessThan(eoa.bars.approvals.score);
  });

  it("counterparty and burst rules behave in the expected direction", () => {
    const few = computeBars([okChain({ counterparties: 1, transfersIn: 5, transfersOut: 5 })], NOW);
    const many = computeBars([okChain({ counterparties: 40 })], NOW);
    expect(many.bars.counterparties.score).toBeGreaterThan(few.bars.counterparties.score);

    // burst: 60 transfers within one day -> bot-like, low score
    const times = Array.from({ length: 60 }, (_, i) => NOW - i * 20 * 60 * 1000);
    const bursty = computeBars([okChain({ transferTimes: times })], NOW);
    expect(bursty.bars.burst.score).toBeLessThanOrEqual(45);
  });

  it("barList lines up with the bar definitions", () => {
    const list = barList(computeBars([okChain()], NOW));
    expect(list.map((b) => b.key)).toEqual(BAR_DEFS.map((d) => d.key));
    expect(list.every((b) => typeof b.note === "string" && b.note.length > 0)).toBe(true);
  });
});
