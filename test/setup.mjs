// Test environment: fake payment addresses, no real keys, fast timeouts.
// The verdict endpoint points at a host that only exists inside fetch mocks.
process.env.GRIDSCORE_PAY_TO = "0x1111111111111111111111111111111111111111";
process.env.GRIDSCORE_USDC_ADDRESS = "0x2222222222222222222222222222222222222222";
process.env.GRIDSCORE_USDC_DECIMALS = "6";
process.env.GRIDSCORE_PRICE_USD = "0.75";
process.env.GRIDSCORE_RPC_GOAT = "https://goat.rpc.test";
process.env.GRIDSCORE_CHAIN_TIMEOUT_MS = "8000";
process.env.GRIDSCORE_JOB_HARD_CAP_MS = "50000";
process.env.GRIDSCORE_MAX_TXS_PER_CHAIN = "200";
process.env.GROQ_API_KEY = "test-verdict-key";
process.env.GROQ_MODEL = "test-verdict-model";
process.env.GROQ_BASE_URL = "https://verdict.test/v1";
process.env.GRIDSCORE_VERDICT_TIMEOUT_MS = "3000";

// Fresh, isolated state file per test run (worker order store).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.GRIDSCORE_STATE_FILE = join(
  mkdtempSync(join(tmpdir(), "gridscore-test-")),
  "state.jsonl"
);
