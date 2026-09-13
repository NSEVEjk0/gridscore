/**
 * The 12 Gridscore bars. Pure rule-based functions over the chain data
 * collected in chains.mjs. No model calls here — every number must be
 * derivable from public RPC data, or marked Unknown / N/A.
 *
 * A bar is one of:
 *   score: 0-100 (int)
 *   "unknown" — the chain data could not be observed (timeout / no data)
 *   "na"      — the category does not apply (e.g. no labels list configured)
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const BAR_DEFS = [
  { key: "presence", label: "Presence" },
  { key: "activity", label: "Activity" },
  { key: "age", label: "Age" },
  { key: "balance", label: "Balance footprint" },
  { key: "clutter", label: "Token clutter" },
  { key: "contract", label: "Contract / verification" },
  { key: "approvals", label: "Approvals" },
  { key: "counterparties", label: "Counterparty concentration" },
  { key: "burst", label: "Burst / bot pattern" },
  { key: "failed", label: "Failed transactions" },
  { key: "crosschain", label: "Cross-chain echo" },
  { key: "labels", label: "Public labels" },
];

function clampScore(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function computeBars(chainResults, nowMs = Date.now()) {
  const ok = chainResults.filter((c) => c.status === "ok");
  const knownCount = ok.length;
  const totalChains = chainResults.length;

  // ---- 1. Presence: any footprint on any reachable chain.
  const withFootprint = ok.filter(
    (c) => c.nonce > 0 || c.balance > 0 || c.isContract || c.transfersIn + c.transfersOut > 0
  );
  const presence =
    knownCount === 0
      ? "unknown"
      : clampScore(30 + (withFootprint.length / knownCount) * 70);

  // ---- 2. Activity: total nonce across reachable chains, log-ish buckets.
  const totalNonce = ok.reduce((acc, c) => acc + c.nonce, 0);
  const activity =
    knownCount === 0
      ? "unknown"
      : totalNonce === 0
        ? 10
        : totalNonce <= 5
          ? 40
          : totalNonce <= 20
            ? 60
            : totalNonce <= 100
              ? 80
              : 95;

  // ---- 3. Age: oldest observed activity among capped recent logs.
  const oldest = ok
    .map((c) => c.oldestActivityMs)
    .filter((t) => typeof t === "number" && t > 0)
    .sort((a, b) => a - b)[0] ?? null;
  let age = "unknown";
  if (oldest !== null) {
    const days = (nowMs - oldest) / DAY_MS;
    age =
      days < 7 ? 20 : days < 30 ? 40 : days < 180 ? 60 : days < 730 ? 80 : 90;
  }

  // ---- 4. Balance footprint: largest native balance on any chain.
  const maxBalance = ok.reduce((acc, c) => Math.max(acc, c.balance || 0), 0);
  const balance =
    knownCount === 0
      ? "unknown"
      : maxBalance <= 0
        ? 10
        : maxBalance < 0.01
          ? 30
          : maxBalance < 1
            ? 55
            : maxBalance < 100
              ? 75
              : 90;

  // ---- 5. Token clutter: distinct tokens across chains (recent window).
  const distinctTokens = ok.reduce((acc, c) => acc + (c.distinctTokens || 0), 0);
  const clutter =
    knownCount === 0
      ? "unknown"
      : distinctTokens <= 2
        ? 70
        : distinctTokens <= 10
          ? 80
          : distinctTokens <= 50
            ? 60
            : 35;

  // ---- 6. Contract / verification: EOA vs contract account.
  const isContract = ok.some((c) => c.isContract);
  const contract =
    knownCount === 0
      ? "unknown"
      : isContract
        ? 40
        : 75;

  // ---- 7. Approvals: ERC-20 approvals granted (recent window).
  const approvals = ok.reduce((acc, c) => acc + (c.approvals || 0), 0);
  const approvalScore =
    knownCount === 0
      ? "unknown"
      : approvals === 0
        ? 85
        : approvals <= 5
          ? 70
          : approvals <= 20
            ? 45
            : 25;

  // ---- 8. Counterparty concentration: distinct counterparties in transfers.
  const counterparties = ok.reduce((acc, c) => acc + (c.counterparties || 0), 0);
  const transfers = ok.reduce((acc, c) => acc + c.transfersIn + c.transfersOut, 0);
  const concentration =
    knownCount === 0
      ? "unknown"
      : transfers === 0
        ? 50
        : counterparties <= 1
          ? 30
          : counterparties <= 3
            ? 45
            : counterparties <= 10
              ? 65
              : 80;

  // ---- 9. Burst / bot: transfers per day across the observed window.
  let burst = "unknown";
  if (knownCount > 0) {
    const times = ok.flatMap((c) => c.transferTimes || []);
    if (times.length < 5) {
      burst = 60; // too little data to judge, neutral-ish
    } else {
      const spanMs = Math.max(...times) - Math.min(...times);
      const spanDays = Math.max(spanMs / DAY_MS, 0.0417); // at least 1 hour
      const perDay = times.length / spanDays;
      burst = perDay > 100 ? 25 : perDay > 20 ? 45 : 70;
    }
  }

  // ---- 10. Failed transactions: not observable through standard public
  // RPC methods (no per-address tx listing). Honest Unknown, never a guess.
  const failed = "unknown";

  // ---- 11. Cross-chain echo: how many chains show any activity.
  const activeChains = withFootprint.length;
  const crosschain =
    knownCount === 0
      ? "unknown"
      : activeChains <= 1
        ? 50
        : activeChains <= 3
          ? 70
          : 85;

  // ---- 12. Public labels: no labels list is configured -> N/A.
  const labels = "na";

  const bars = {
    presence: {
      score: presence,
      note:
        presence === "unknown"
          ? "No chain could be reached"
          : `${withFootprint.length} of ${totalChains} chains show any footprint`,
    },
    activity: {
      score: activity,
      note:
        activity === "unknown"
          ? "No chain could be reached"
          : `${totalNonce} transactions sent across reachable chains`,
    },
    age: {
      score: age,
      note:
        age === "unknown"
          ? "No dated activity in the observed window"
          : `Active since at least ${new Date(oldest).toISOString().slice(0, 10)} (observed window)`,
    },
    balance: {
      score: balance,
      note:
        balance === "unknown"
          ? "No chain could be reached"
          : `Largest native balance seen: ${maxBalance.toFixed(4)} (chain units)`,
    },
    clutter: {
      score: clutter,
      note:
        clutter === "unknown"
          ? "No chain could be reached"
          : `${distinctTokens} distinct tokens in the observed window`,
    },
    contract: {
      score: contract,
      note:
        contract === "unknown"
          ? "No chain could be reached"
          : isContract
            ? "Account has contract code; source verification not checked"
            : "Regular account (no contract code)",
    },
    approvals: {
      score: approvalScore,
      note:
        approvalScore === "unknown"
          ? "No chain could be reached"
          : `${approvals} token approvals granted in the observed window`,
    },
    counterparties: {
      score: concentration,
      note:
        concentration === "unknown"
          ? "No chain could be reached"
          : transfers === 0
            ? "No transfers in the observed window"
            : `${counterparties} distinct counterparties over ${transfers} transfers`,
    },
    burst: {
      score: burst,
      note:
        burst === "unknown"
          ? "No chain could be reached"
          : timesNote(ok),
    },
    failed: {
      score: failed,
      note: "Failure rates are not observable through public RPC",
    },
    crosschain: {
      score: crosschain,
      note:
        crosschain === "unknown"
          ? "No chain could be reached"
          : `Active on ${activeChains} of ${knownCount} reachable chains`,
    },
    labels: {
      score: labels,
      note: "No public labels list is configured for this deployment",
    },
  };

  // Overall: average of bars that have a numeric score.
  const numeric = Object.values(bars)
    .map((b) => b.score)
    .filter((s) => typeof s === "number");
  const overall =
    numeric.length === 0 ? "unknown" : clampScore(numeric.reduce((a, b) => a + b, 0) / numeric.length);

  const dataBars = numeric.length;

  return {
    bars,
    overall,
    meta: {
      chainsReachable: knownCount,
      chainsTotal: totalChains,
      unknownChains: chainResults
        .filter((c) => c.status === "unknown")
        .map((c) => c.chainName),
      dataBars,
    },
  };
}

function timesNote(ok) {
  const times = ok.flatMap((c) => c.transferTimes || []);
  if (times.length < 5) return "Fewer than 5 dated transfers observed";
  const spanDays = Math.max((Math.max(...times) - Math.min(...times)) / DAY_MS, 0.0417);
  const perDay = times.length / spanDays;
  return `${times.length} dated transfers, about ${perDay.toFixed(1)} per day in the observed window`;
}

export function barList(score) {
  return BAR_DEFS.map((d) => ({ ...d, ...score.bars[d.key] }));
}
