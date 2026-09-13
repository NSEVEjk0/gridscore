import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VERDICTS,
  agentVerdict,
  llmVerdict,
  templateVerdict,
  verdictInput,
} from "../worker/verdict.mjs";
import { computeBars } from "../worker/score.mjs";

const NOW = 1_750_000_000_000;

function okChain(overrides = {}) {
  return {
    status: "ok",
    chain: "goat",
    chainName: "GOAT",
    chainId: 2345,
    nonce: 30,
    balance: 2,
    isContract: false,
    transfersOut: 10,
    transfersIn: 20,
    distinctTokens: 5,
    counterparties: 12,
    approvals: 2,
    approvalSpenders: 2,
    transferTimes: [NOW - 100 * 24 * 3600 * 1000, NOW - 5 * 24 * 3600 * 1000],
    oldestActivityMs: NOW - 800 * 24 * 3600 * 1000,
    newestActivityMs: NOW,
    examined: 30,
    capped: false,
    ...overrides,
  };
}

function llmResponse(content) {
  return new Response(JSON.stringify(content), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("template verdict", () => {
  it("maps the bars to the allowed verdicts", () => {
    // hostile signals: contract, heavy approvals, token spam, one counterparty, bot burst
    const burstyTimes = Array.from({ length: 200 }, (_, i) => NOW - i * 7 * 60 * 1000);
    const hostile = templateVerdict(
      computeBars(
        [
          okChain({
            isContract: true,
            approvals: 40,
            distinctTokens: 60,
            counterparties: 1,
            transferTimes: burstyTimes,
          }),
        ],
        NOW
      )
    );
    expect(hostile.verdict).toBe("Do not interact");

    // one weak bar (a handful of approvals) pulls the verdict to dust-only
    const mid = templateVerdict(computeBars([okChain({ approvals: 15 })], NOW));
    expect(mid.verdict).toBe("Test with dust only");

    // clean, active, spread out
    const high = templateVerdict(computeBars([okChain()], NOW));
    expect(high.verdict).toBe("OK for small, known use");
  });

  it("says Not enough data when the bars are mostly unknown or the address is empty", () => {
    const score = computeBars(
      [{ status: "unknown", chain: "goat", chainName: "GOAT", chainId: 2345, reason: "timeout" }],
      NOW
    );
    expect(templateVerdict(score).verdict).toBe("Not enough data");

    const empty = computeBars(
      [
        okChain({
          nonce: 0,
          balance: 0,
          transfersIn: 0,
          transfersOut: 0,
          approvals: 0,
          counterparties: 0,
          distinctTokens: 0,
          transferTimes: [],
          oldestActivityMs: null,
        }),
      ],
      NOW
    );
    expect(templateVerdict(empty).verdict).toBe("Not enough data");
  });

  it("always gives exactly 3 reasons and 2 not-checked, drawn from the bars", () => {
    const v = templateVerdict(computeBars([okChain()], NOW));
    expect(v.reasons).toHaveLength(3);
    expect(v.notChecked).toHaveLength(2);
    // every reason names a bar with its score
    expect(v.reasons.every((r) => /: \d+\/100 — /.test(r) || /Unknown|N\/A/.test(r))).toBe(true);
  });

  it("never uses the forbidden words", () => {
    for (const v of VERDICTS) {
      expect(/\b(safe|legit|guaranteed scam)\b/i.test(v)).toBe(false);
    }
  });
});

describe("agent verdict via the configured endpoint", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends only the bars JSON and returns a validated verdict", async () => {
    let captured;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        captured = { url: String(url), init };
        return llmResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: "Test with dust only",
                  reasons: ["r1", "r2", "r3"],
                  notChecked: ["n1", "n2"],
                }),
              },
            },
          ],
        });
      })
    );
    const score = computeBars([okChain()], NOW);
    const v = await agentVerdict(score);

    expect(v.source).toBe("model");
    expect(v.verdict).toBe("Test with dust only");

    // request shape: model endpoint, auth header, JSON-mode
    expect(captured.url).toBe("https://verdict.test/v1/chat/completions");
    expect(captured.init.headers.Authorization).toBe("Bearer test-verdict-key");
    expect(JSON.parse(captured.init.body).response_format.type).toBe("json_object");

    // the model saw ONLY the bars JSON — parse it and check contents
    const userMsg = JSON.parse(captured.init.body).messages[1].content;
    const parsed = JSON.parse(userMsg);
    expect(parsed.overall).toBe(score.overall);
    expect(parsed.bars).toHaveLength(12);
    expect(parsed.bars[0]).toHaveProperty("label");
    expect(parsed.bars[0]).toHaveProperty("score");
    // no invented chain-level raw data leaked into the prompt
    expect(parsed.bars[0]).not.toHaveProperty("nonce");
    expect(JSON.stringify(parsed)).not.toContain("transferTimes");
  });

  it("rejects a verdict outside the allowed set and falls back to template", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        llmResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: "This address is totally safe",
                  reasons: ["r1", "r2", "r3"],
                  notChecked: ["n1", "n2"],
                }),
              },
            },
          ],
        })
      )
    );
    const score = computeBars([okChain()], NOW);
    const v = await agentVerdict(score);
    expect(v.source).toBe("template");
    expect(VERDICTS).toContain(v.verdict);
  });

  it("falls back to the template when the endpoint fails or times out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const score = computeBars([okChain()], NOW);
    expect((await agentVerdict(score)).source).toBe("template");

    // a hanging endpoint is cut off by the verdict timeout
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("This operation was aborted", "AbortError"))
            );
          })
      )
    );
    const t = await Promise.race([
      llmVerdict(computeBars([okChain()], NOW)),
      new Promise((r) => setTimeout(() => r("still-pending"), 4000)),
    ]);
    expect(t).toBeNull();
  });

  it("wrong reason count is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        llmResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: "OK for small, known use",
                  reasons: ["only one"],
                  notChecked: ["n1", "n2"],
                }),
              },
            },
          ],
        })
      )
    );
    const v = await agentVerdict(computeBars([okChain()], NOW));
    expect(v.source).toBe("template");
  });
});
