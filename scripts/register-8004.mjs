#!/usr/bin/env node
/**
 * Register the Gridscore agent on the GOAT Network ERC-8004 IdentityRegistry.
 *
 * Requires GOAT ETH in the payment wallet for gas. Run:
 *
 *   node scripts/register-8004.mjs
 *
 * It registers the agent with the hosted registration JSON as its URI,
 * prints the on-chain agentId, and prints the exact line to update in
 * public/agent.json (registrations[0].agentId) and .env.local
 * (GRIDSCORE_ERC8004_AGENT_ID). Never prints or commits private keys.
 */
import { Wallet, JsonRpcProvider, Contract, formatUnits } from "ethers";
import { readFileSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";

const RPC = process.env.GRIDSCORE_RPC_GOAT || "https://rpc.goat.network";
const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const AGENT_URI = "https://gridscore-ckay.vercel.app/agent.json";

// The key lives in /root/.splitpot-test-wallet.json (mode 600) — the wallet
// funded for testing, whose address doubles as the agent owner.
let key;
try {
  key = JSON.parse(readFileSync(`${homedir()}/.splitpot-test-wallet.json`)).privateKey;
} catch {
  console.error("FAIL — no wallet file at ~/.splitpot-test-wallet.json");
  process.exit(1);
}

const provider = new JsonRpcProvider(RPC);
const wallet = new Wallet(key, provider);
const balance = await provider.getBalance(wallet.address);
console.log(`owner wallet: ${wallet.address}`);
console.log(`GOAT ETH balance: ${formatUnits(balance, 18)}`);
if (balance === 0n) {
  console.error(
    "FAIL — the wallet has no GOAT ETH for gas. Fund it, then re-run this script."
  );
  process.exit(1);
}

const registry = new Contract(
  REGISTRY,
  [
    "function register(string agentURI) returns (uint256)",
    "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  ],
  wallet
);

console.log(`registering agent with URI ${AGENT_URI} …`);
const tx = await registry.register(AGENT_URI);
console.log(`tx: ${tx.hash}`);
const rc = await tx.wait();
if (rc.status !== 1) {
  console.error("FAIL — transaction reverted");
  process.exit(1);
}
const ev = rc.logs
  .map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } })
  .find((p) => p && p.name === "Registered");
const agentId = ev ? ev.args.agentId.toString() : "unknown";
console.log(`\nSUCCESS — agentId ${agentId}`);
console.log(`explorer: https://explorer.goat.network/tx/${tx.hash}`);

// Update public/agent.json with the real id.
const regPath = new URL("../public/agent.json", import.meta.url);
const reg = JSON.parse(readFileSync(regPath));
reg.registrations[0].agentId = Number(agentId);
writeFileSync(regPath, JSON.stringify(reg, null, 2) + "\n");
console.log(`updated public/agent.json (agentId ${agentId})`);
console.log(`\nThen set GRIDSCORE_ERC8004_AGENT_ID=${agentId} in .env.local and restart the worker.`);
