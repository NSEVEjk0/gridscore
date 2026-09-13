# Gridscore

You are about to send funds to an address, or approve a contract. Before you
do, Gridscore reads what public blockchains say about that address and gives
you a straight answer.

**How it works:**

1. Paste a `0x` address.
2. Pay **$0.75 USDC on GOAT Network**. One payment, one report.
3. A scan runs: GOAT, Ethereum, Base, Arbitrum, Optimism, Polygon, BNB and
   Avalanche are read in parallel, straight from public RPCs.
4. You get **12 rule-based bars** and one **Agent verdict**.

No report is produced until the payment is confirmed on-chain. Your GOAT
transaction hash is shown on the report as the receipt.

## The 12 bars

Presence · Activity · Age · Balance footprint · Token clutter ·
Contract / verification · Approvals · Counterparty concentration ·
Burst / bot pattern · Failed transactions · Cross-chain echo · Public labels

Every bar is computed by a fixed rule from public chain data, and the rule is
shown next to the bar. When something cannot be observed — a chain that does
not answer in time, failure rates that public RPCs do not expose, or labels
when no list is configured — the bar says **Unknown** or **N/A**, never a
made-up zero. **Overall** is the average of the bars that were actually
scored.

## The Agent verdict

The verdict is exactly one of:

- **Do not interact**
- **Test with dust only**
- **OK for small, known use**
- **Not enough data**

It comes with 3 reasons taken from the bars and 2 things Gridscore did not
check. The verdict text is written from the bar values only — no invented
numbers — and if the text service is unreachable, a template built by the
same rules is used instead.

Gridscore never calls an address "safe", "legit", or a "guaranteed scam".
No labels list is configured, so no label claims are ever made.

The report shows the agent's identity in the ERC-8004 format used by GOAT
AgentKit (an agent registry id plus an agent id).

## Honest limits

- **Receive only.** Gridscore charges per scan through GOAT's payment rails
  (an x402-style challenge: a direct USDC transfer to the payment address on
  GOAT, verified on-chain by transaction hash).
- The scan reads public data only. It cannot see private transfers, off-chain
  reputation, or the real-world identity behind an address.
- Token transfers are read from a recent window, capped at ~200 transactions
  per chain. Older history can exist that the bars do not see.
- Public data only. Not financial advice.

## Run it

The app is two processes:

- **Web** — a Next.js app (the page you use). `npm run dev` or `npm run start`.
- **Worker** — the order API, payment watcher and scan engine. `npm run worker`.

```bash
npm install
npm run build
npm run worker   # terminal 1 — the scan worker
npm run start    # terminal 2 — the web app
```

The web app talks to the worker at `WORKER_URL` (default
`http://127.0.0.1:8787`).

Environment variables (names only — values live in `.env.local`, never in
git):

| Variable | Purpose |
| --- | --- |
| `GRIDSCORE_PAY_TO` | The GOAT address that receives the $0.75 |
| `GRIDSCORE_USDC_ADDRESS` | USDC contract on GOAT (Stargate USDC.e by default) |
| `GRIDSCORE_USDC_DECIMALS` | Defaults to 6 |
| `GRIDSCORE_PRICE_USD` | Scan price, defaults to 0.75 |
| `GRIDSCORE_RPC_GOAT` … `GRIDSCORE_RPC_AVALANCHE` | Override any chain RPC |
| `GRIDSCORE_CHAIN_TIMEOUT_MS` | Per-chain timeout, defaults to 8000 |
| `GRIDSCORE_JOB_HARD_CAP_MS` | Whole-job cap, defaults to 50000 |
| `GRIDSCORE_MAX_TXS_PER_CHAIN` | Transaction cap per chain, defaults to 200 |
| `GRIDSCORE_PORT` | Worker port, defaults to 8787 |
| `GRIDSCORE_STATE_FILE` | Order store file, defaults to `data/state.jsonl` |
| `WORKER_URL` | Where the web app finds the worker |
| `VERDICT_API_KEY`, `VERDICT_MODEL`, `VERDICT_BASE_URL` | Optional verdict text provider (OpenAI-compatible endpoint). If unset, the template verdict is used |
| `GRIDSCORE_ERC8004_REGISTRY`, `GRIDSCORE_ERC8004_AGENT_ID` | Agent identity shown on reports |

## Resource caps

The whole job — RPC reads, verdict, save — is hard-capped at **50 seconds**.
Whatever is ready at the deadline is published; unfinished chains are shown
as Unknown. The page shows a 1-minute countdown while scanning and stops the
moment the report lands.

The worker is I/O bound: at most 8 chain fetches run at once, and it is
pinned to 2 CPU cores at startup (`taskset -c 0-1`).

## Tests

```bash
npm test
```

34 tests covering the bar rules, the verdict mapping and fallbacks, the
payment challenge and verification, the order lifecycle end to end, chain
timeouts and caps, and the page footer.

---

Public chain data only. Not financial advice.

Built by @ckay · https://x.com/CRYPTFRANI
