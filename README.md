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

## Payments: official GOAT Flow x402

Gridscore charges per scan over the official **GOAT Flow x402** rails (the
protocol and API from the [GOATNetwork/x402](https://github.com/GOATNetwork/x402)
reference). Two rails, in this order:

1. **GOAT Flow (primary).** When merchant credentials are configured
   (`GOATX402_API_KEY` + `GOATX402_API_SECRET`), every unpaid scan creates a
   real Flow order (`POST /api/v1/orders` on `flow-api.goat.network`, HMAC
   auth) and returns Flow's own HTTP 402 challenge. The payer follows the
   official flow — sign the EIP-712 authorization, transfer USDC on GOAT —
   and Gridscore confirms via `GET /api/v1/orders/{id}` when the status
   reaches `PAYMENT_CONFIRMED`. No second call is needed: the worker polls
   the order and publishes the report by itself.
2. **ERC20-direct (fallback, always on).** Without Flow credentials the 402
   describes a direct USDC transfer on GOAT (the `ERC20_DIRECT` flow from
   the same reference). The payer sends the transfer and retries with
   `X-Payment: <goat tx hash>`; Gridscore verifies the transfer on-chain.

### Getting Flow credentials (merchant portal)

The Flow rail needs an approved merchant account — Gridscore cannot invent
one. Exact steps:

1. Sign up at the merchant portal: **https://flow-merchant.goat.network**
   (testnet: `https://flow-merchant.testnet3.goat.network`).
2. Complete the merchant approval (chain/token config and fee balance are
   reviewed by GOAT).
3. Create an API key + secret in the portal.
4. Put them in the worker's `.env.local`:

```
GOATX402_API_URL=https://flow-api.goat.network
GOATX402_API_KEY=…
GOATX402_API_SECRET=…
```

5. Restart the worker. Every 402 from `/api/agent/v1/scan` is then a real
   Flow order challenge and payment confirmation is fully automatic.

Until then the ERC20-direct fallback works and is verified end to end with
real payments.

## Agent API (x402 pay-per-call)

Other agents can buy scans programmatically, no account needed:

```
POST https://gridscore-ckay.vercel.app/api/agent/v1/scan
Content-Type: application/json

{"address": "0x…"}
```

- **No payment attached** → HTTP **402** with the x402 descriptor (official
  wire format: `x402Version`, `resource`, `accepts[].asset/payTo/extra`)
  plus an `X-Order-Id` header. With Flow configured, this is Flow's own
  challenge and includes the Flow `order_id`.
- **Pay** $0.75 in USDC on GOAT (chain 2345): through the official Flow
  flow, or a direct transfer to the descriptor's `payTo`.
- **Retry** with `X-Payment: <goat tx hash>` (or a Flow order id) → **202**
  with `{orderId, poll}`. With Flow, no retry is needed — the worker
  watches the order.
- **Poll** `GET /api/agent/v1/report/{orderId}` → **202** while scanning,
  then the JSON report: the 12 bars, the verdict, `goatTx` + `goatTxUrl`
  (the payment receipt on the GOAT explorer), and the agent's **ERC-8004
  identity** (`agentRegistry` + `agentId`).
- `GET /api/agent/v1/tiers` — price discovery. `GET /api/agent/v1/agent` —
  the identity block. `/agent.json` — the ERC-8004 registration document.

Each transaction hash pays for exactly one scan.

## ERC-8004 identity

The screening agent is registered on the **GOAT Network ERC-8004
IdentityRegistry** (canonical mainnet deployment
`eip155:2345:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`) as
**agent id 85**, owned by the payment wallet, registered in transaction
[0xbd1bed42…9c867](https://explorer.goat.network/tx/0xbd1bed4271f777218cc0a399f3503b53baece3f48a8c1f4590a7f38cd9b9c867).
The registration document is served at
[gridscore-ckay.vercel.app/agent.json](https://gridscore-ckay.vercel.app/agent.json)
with the x402 scan endpoint listed under `services` and `x402Support: true`,
per the ERC-8004 registration schema. Every report and API response carries
the registry id and the agent id.

## AgentKit and ClawUp

Gridscore speaks the documented Flow API wire format directly (order create,
status, proof; HMAC auth), which is the same protocol the
`@goatnetwork/agentkit` x402 / x402-merchant plugins use — so an agent
running AgentKit's payer plugin (`goat.x402.payment.*` actions) can pay for
scans without any Gridscore-specific code. The ERC-8004 registration follows
AgentKit's identity schema.

**To attach Gridscore in ClawUp** (clawup.org): create or open your Claw,
go to **Agent → Tools → Marketplace**, and add an HTTP/MCP tool pointing at
the paid scan endpoint `https://gridscore-ckay.vercel.app/api/agent/v1/scan`
(the 402 → pay → retry flow is the standard x402 loop). Your Claw then pays
per scan from its wallet like any other caller.

## Testnet faucet (testnet only)

The GOAT faucet at https://bridge.testnet3.goat.network/faucet funds
**testnet3 (chain 48816) only**. The production Gridscore site runs on
GOAT mainnet (chain 2345), where a scan costs real $0.75 USDC — faucet
tokens cannot pay for it.

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

- **Receive only.** Gridscore charges per scan through GOAT's official
  payment rails: GOAT Flow x402 when merchant credentials are configured,
  otherwise the documented ERC20-direct transfer verified on-chain by
  transaction hash.
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
| `GOATX402_API_URL` | Official GOAT Flow x402 API (default `https://flow-api.goat.network`) |
| `GOATX402_API_KEY` | Flow merchant API key (from the merchant portal) |
| `GOATX402_API_SECRET` | Flow merchant API secret |
| `GRIDSCORE_PAY_TO` | The GOAT address that receives the $0.75 (erc20-direct rail, and Flow payee) |
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
| `GRIDSCORE_ERC8004_REGISTRY`, `GRIDSCORE_ERC8004_AGENT_ID` | Agent identity shown on reports (registered: registry `eip155:2345:0x8004…a432`, agent id 85) |

## Resource caps

The whole job — RPC reads, verdict, save — is hard-capped at **50 seconds**.
Whatever is ready at the deadline is published; unfinished chains are shown
as Unknown. The page shows a 1-minute countdown while scanning and stops the
moment the report lands.

The worker is I/O bound: at most 8 chain fetches run at once, and it is
pinned to 2 CPU cores at startup (`taskset -c 0-1`).

## Website history and navigation

Every scan started in a browser is remembered on that device at `/history`
(address, outcome, verdict chip). Clicking a past scan reopens its report.
Every screen after the home page has a back button that returns to the
previous screen.

## Tests

```bash
npm test
```

58 tests covering the bar rules, the verdict mapping and fallbacks, the
official Flow x402 client (HMAC signing, order create, status mapping), the
payment challenge and verification on both rails, the order lifecycle end to
end, chain timeouts and caps, and the page footer.

---

Public chain data only. Not financial advice.

Built by @ckay · https://x.com/CRYPTFRANI
