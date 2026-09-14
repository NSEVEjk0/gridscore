import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";

// .env.local in the repo root, without overriding real env vars
// (so a platform's injected env always wins).
if (existsSync(".env.local")) {
  loadDotenv({ path: ".env.local", override: false });
}

const env = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
};

/**
 * Each chain lists several public RPC endpoints; the scanner tries them in
 * order until one answers. Set GRIDSCORE_RPC_<KEY> to force a specific one.
 */
function chain(key, name, chainId, defaults) {
  const override = process.env[`GRIDSCORE_RPC_${key.toUpperCase()}`];
  return { key, name, chainId, rpcs: override ? [override, ...defaults] : defaults };
}

export const CHAINS = [
  chain("goat", "GOAT", 2345, [
    "https://rpc.goat.network",
    "https://rpc.ankr.com/goat_mainnet",
  ]),
  chain("ethereum", "Ethereum", 1, [
    "https://ethereum-rpc.publicnode.com",
    "https://cloudflare-eth.com",
  ]),
  chain("base", "Base", 8453, [
    "https://base-rpc.publicnode.com",
    "https://mainnet.base.org",
  ]),
  chain("arbitrum", "Arbitrum", 42161, [
    "https://arbitrum-one-rpc.publicnode.com",
    "https://arb1.arbitrum.io/rpc",
  ]),
  chain("optimism", "Optimism", 10, [
    "https://optimism-rpc.publicnode.com",
    "https://mainnet.optimism.io",
  ]),
  chain("polygon", "Polygon", 137, [
    "https://polygon-bor-rpc.publicnode.com",
    "https://1rpc.io/matic",
  ]),
  chain("bnb", "BNB", 56, [
    "https://bsc-rpc.publicnode.com",
    "https://bsc-dataseed.binance.org",
  ]),
  chain("avalanche", "Avalanche", 43114, [
    "https://avalanche-c-chain-rpc.publicnode.com",
    "https://api.avax.network/ext/bc/C/rpc",
  ]),
];

export function goatRpcs() {
  return CHAINS.find((c) => c.key === "goat").rpcs;
}

// GOAT Network payment rails (x402-style ERC20 direct transfer).
export const PAY = {
  network: "goat-mainnet",
  chainId: 2345,
  payTo: env("GRIDSCORE_PAY_TO", "").toLowerCase(),
  usdc: env("GRIDSCORE_USDC_ADDRESS", "0x3022b87ac063DE95b1570F46f5e470F8B53112D8").toLowerCase(),
  usdcDecimals: Number(env("GRIDSCORE_USDC_DECIMALS", "6")),
  priceUsd: Number(env("GRIDSCORE_PRICE_USD", "0.75")),
  explorerTx: env("GRIDSCORE_EXPLORER_TX", "https://explorer.goat.network/tx/"),
};

export const LIMITS = {
  chainTimeoutMs: Number(env("GRIDSCORE_CHAIN_TIMEOUT_MS", "8000")),
  jobHardCapMs: Number(env("GRIDSCORE_JOB_HARD_CAP_MS", "50000")),
  maxTxsPerChain: Number(env("GRIDSCORE_MAX_TXS_PER_CHAIN", "200")),
  maxChainConcurrency: Number(env("GRIDSCORE_MAX_CHAIN_CONCURRENCY", "8")),
  watchPollMs: Number(env("GRIDSCORE_WATCH_POLL_MS", "2500")),
};

// Optional verdict provider (OpenAI-compatible chat completions endpoint).
// Reads GROQ_* first, then VERDICT_* aliases. If unset or unreachable,
// the worker falls back to a template verdict derived from the bars.
export const VERDICT = {
  apiKey: env("GROQ_API_KEY", env("VERDICT_API_KEY", "")),
  model: env("GROQ_MODEL", env("VERDICT_MODEL", "")),
  baseUrl: (env("GROQ_BASE_URL", env("VERDICT_BASE_URL", "")) || "").replace(/\/+$/, ""),
  timeoutMs: Number(env("GRIDSCORE_VERDICT_TIMEOUT_MS", "12000")),
};

// ERC-8004 agent identity shown on reports (GOAT AgentKit registry format).
export const AGENT = {
  registry: env(
    "GRIDSCORE_ERC8004_REGISTRY",
    "eip155:2345:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"
  ),
  agentId: env("GRIDSCORE_ERC8004_AGENT_ID", ""),
  agentUri: env("GRIDSCORE_ERC8004_AGENT_URI", "https://gridscore-ckay.vercel.app/agent.json"),
};

export const WORKER_PORT = Number(env("GRIDSCORE_PORT", "8787"));
export const WORKER_BIND = env("GRIDSCORE_BIND", "0.0.0.0");

export function priceInUnits() {
  // $0.75 at 6 decimals -> "750000". Computed, never hardcoded.
  return BigInt(Math.round(PAY.priceUsd * 10 ** PAY.usdcDecimals)).toString();
}
