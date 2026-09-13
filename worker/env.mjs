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

export const CHAINS = [
  { key: "goat", name: "GOAT", chainId: 2345, rpc: env("GRIDSCORE_RPC_GOAT", "https://rpc.goat.network") },
  { key: "ethereum", name: "Ethereum", chainId: 1, rpc: env("GRIDSCORE_RPC_ETHEREUM", "https://eth.llamarpc.com") },
  { key: "base", name: "Base", chainId: 8453, rpc: env("GRIDSCORE_RPC_BASE", "https://mainnet.base.org") },
  { key: "arbitrum", name: "Arbitrum", chainId: 42161, rpc: env("GRIDSCORE_RPC_ARBITRUM", "https://arb1.arbitrum.io/rpc") },
  { key: "optimism", name: "Optimism", chainId: 10, rpc: env("GRIDSCORE_RPC_OPTIMISM", "https://mainnet.optimism.io") },
  { key: "polygon", name: "Polygon", chainId: 137, rpc: env("GRIDSCORE_RPC_POLYGON", "https://polygon-rpc.com") },
  { key: "bnb", name: "BNB", chainId: 56, rpc: env("GRIDSCORE_RPC_BNB", "https://bsc-dataseed.binance.org") },
  { key: "avalanche", name: "Avalanche", chainId: 43114, rpc: env("GRIDSCORE_RPC_AVALANCHE", "https://api.avax.network/ext/bc/C/rpc") },
];

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
  agentId: env("GRIDSCORE_ERC8004_AGENT_ID", "1"),
};

export const WORKER_PORT = Number(env("GRIDSCORE_PORT", "8787"));

export function priceInUnits() {
  // $0.75 at 6 decimals -> "750000". Computed, never hardcoded.
  return BigInt(Math.round(PAY.priceUsd * 10 ** PAY.usdcDecimals)).toString();
}
