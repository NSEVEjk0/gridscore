"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TXHASH_RE = /^0x[0-9a-fA-F]{64}$/;
const COUNTDOWN_SECONDS = 60;

interface BarEntry {
  key: string;
  score: number | string;
  note: string;
}

const BAR_LABELS: Record<string, string> = {
  presence: "Presence",
  activity: "Activity",
  age: "Age",
  balance: "Balance footprint",
  clutter: "Token clutter",
  contract: "Contract / verification",
  approvals: "Approvals",
  counterparties: "Counterparty concentration",
  burst: "Burst / bot pattern",
  failed: "Failed transactions",
  crosschain: "Cross-chain echo",
  labels: "Public labels",
};

const VERDICT_CLASS: Record<string, string> = {
  "Do not interact": "v-do-not",
  "Test with dust only": "v-dust",
  "OK for small, known use": "v-ok",
  "Not enough data": "v-nodata",
};

interface Order {
  orderId: string;
  address: string;
  status: "awaiting_payment" | "scanning" | "done" | "expired";
  challenge: {
    accepts: Array<{
      networkName: string;
      tokenSymbol: string;
      amountHuman: string;
      payTo: string;
      chainId: number;
    }>;
  };
  payment?: { paidAt: string | null; txHash: string | null } | null;
  report?: {
    overall: number | string;
    barList: BarEntry[];
    verdict: { verdict: string; reasons: string[]; notChecked: string[]; source: string };
    agent: { erc8004: { agentRegistry: string; agentId: string } };
    payment: { txHash: string | null };
  } | null;
}

export default function HomePage() {
  const [phase, setPhase] = useState<"idle" | "pay" | "scan" | "done">("idle");
  const [order, setOrder] = useState<Order | null>(null);
  const [address, setAddress] = useState("");
  const [txHash, setTxHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimers = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
    pollRef.current = null;
    countdownRef.current = null;
  }, []);

  useEffect(() => stopTimers, [stopTimers]);

  const applyOrder = useCallback(
    (o: Order) => {
      setOrder(o);
      if (o.status === "awaiting_payment") setPhase("pay");
      if (o.status === "scanning") setPhase("scan");
      if (o.status === "done" && o.report) {
        stopTimers();
        setPhase("done");
      }
      if (o.status === "expired") {
        stopTimers();
        setError("This order expired unpaid. Start a new scan.");
        setPhase("idle");
      }
    },
    [stopTimers]
  );

  // Poll order status while paying or scanning.
  useEffect(() => {
    if ((phase !== "pay" && phase !== "scan") || !order) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/order/${order.orderId}`, { cache: "no-store" });
        if (!res.ok) return;
        applyOrder(await res.json());
      } catch {
        // transient; keep polling
      }
    }, 2500);
    pollRef.current = id;
    return () => clearInterval(id);
  }, [phase, order?.orderId, applyOrder, order]);

  // 1-minute countdown while scanning; stops the moment the report lands.
  useEffect(() => {
    if (phase !== "scan") return;
    setCountdown(COUNTDOWN_SECONDS);
    const id = setInterval(() => {
      setCountdown((c) => (c <= 1 ? 0 : c - 1));
    }, 1000);
    countdownRef.current = id;
    return () => clearInterval(id);
  }, [phase]);

  async function startScan(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const addr = address.trim();
    if (!ADDRESS_RE.test(addr)) {
      setError("Enter a valid 0x address.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: addr }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error || `Could not start the order (${res.status}).`);
        return;
      }
      setPhase("pay");
      setOrder(body);
    } catch {
      setError("Network error while starting the order.");
    } finally {
      setBusy(false);
    }
  }

  async function claimPayment(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const tx = txHash.trim();
    if (!TXHASH_RE.test(tx)) {
      setError("Paste the full 0x transaction hash from GOAT.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/order/${order!.orderId}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash: tx }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error || `Payment not confirmed yet (${res.status}).`);
        return;
      }
      applyOrder(body);
    } catch {
      setError("Network error while checking the payment.");
    } finally {
      setBusy(false);
    }
  }

  function copy(text: string) {
    if (navigator?.clipboard) navigator.clipboard.writeText(text);
  }

  function restart() {
    stopTimers();
    setPhase("idle");
    setOrder(null);
    setAddress("");
    setTxHash("");
    setError(null);
  }

  const accept = order?.challenge?.accepts?.[0];

  return (
    <div>
      {phase === "idle" ? (
        <>
          <p className="kicker">Address screening</p>
          <h1>
            Check an address before you send funds or approve a contract.
          </h1>
          <p className="lead">
            Gridscore reads public chain data on eight networks, scores 12 bars
            with fixed rules, and gives one agent verdict. One scan costs $0.75
            USDC, paid on GOAT Network.
          </p>
          <form className="card" onSubmit={startScan}>
            <label htmlFor="address">Wallet address</label>
            <div className="copy-row">
              <input
                id="address"
                className="mono"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="0x…"
                spellCheck={false}
              />
              <button type="submit" disabled={busy}>
                {busy ? "Starting…" : "Start scan"}
              </button>
            </div>
            {error ? <p className="error" role="alert">{error}</p> : null}
            <p className="hint">
              You will get a payment step on GOAT Network before any data is
              collected. No report is produced until the payment is confirmed
              on-chain.
            </p>
          </form>
        </>
      ) : null}

      {phase === "pay" && order && accept ? (
        <>
          <p className="step-tag">Step 2 · Pay on GOAT</p>
          <h1>Send {accept.amountHuman} {accept.tokenSymbol} on GOAT Network</h1>
          <p className="lead">
            One payment, one report. Send the transfer from any wallet you
            like — Gridscore watches the GOAT chain and starts the scan the
            moment the transfer lands.
          </p>
          <div className="card">
            <label>Amount</label>
            <div className="kv">
              <div>
                <div className="k">Amount</div>
                <div className="v mono">{accept.amountHuman} {accept.tokenSymbol}</div>
              </div>
              <div>
                <div className="k">Network</div>
                <div className="v">{accept.networkName} (chain {accept.chainId})</div>
              </div>
            </div>
            <label>Send to</label>
            <div className="copy-row">
              <input className="mono" readOnly value={accept.payTo} />
              <button type="button" className="btn-ghost" onClick={() => copy(accept.payTo)}>
                Copy
              </button>
            </div>
            <p className="hint">
              USDC transfer, ordinary ERC-20 send. Nothing else is needed — no
              signature, no approval.
            </p>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 18 }}>
              <span className="spinner" />
              <span className="scan-note">Watching the GOAT chain for your payment…</span>
            </div>
            <form onSubmit={claimPayment}>
              <label htmlFor="txhash">Already paid? Paste your GOAT transaction hash</label>
              <div className="copy-row">
                <input
                  id="txhash"
                  className="mono"
                  value={txHash}
                  onChange={(e) => setTxHash(e.target.value)}
                  placeholder="0x…"
                  spellCheck={false}
                />
                <button type="submit" disabled={busy}>
                  {busy ? "Checking…" : "Check payment"}
                </button>
              </div>
            </form>
            {error ? <p className="error" role="alert">{error}</p> : null}
            <p className="hint">
              Prefer to pay later? The order stays open for two hours.{" "}
              <a href="#" onClick={(e) => { e.preventDefault(); restart(); }} style={{ color: "var(--accent)" }}>
                Cancel
              </a>
            </p>
          </div>
        </>
      ) : null}

      {phase === "scan" && order ? (
        <>
          <p className="step-tag">Step 3 · Scanning</p>
          <h1>Reading the chains</h1>
          <p className="lead mono" style={{ wordBreak: "break-all" }}>{order.address}</p>
          <div className="card" style={{ textAlign: "center", padding: "36px 22px" }}>
            <div className="countdown">{countdown}s</div>
            <p className="scan-note">
              Payment confirmed. The agent is reading GOAT, Ethereum, Base,
              Arbitrum, Optimism, Polygon, BNB and Avalanche. The report appears
              the moment it is ready — at most within a minute.
            </p>
            {order.payment?.txHash ? (
              <p className="paid-tag mono" style={{ wordBreak: "break-all" }}>
                GOAT payment tx: {order.payment.txHash}
              </p>
            ) : null}
          </div>
        </>
      ) : null}

      {phase === "done" && order?.report ? (
        <Report order={order} onRestart={restart} />
      ) : null}
    </div>
  );
}

function Report({ order, onRestart }: { order: Order; onRestart: () => void }) {
  const r = order.report!;
  const overall = typeof r.overall === "number" ? r.overall : null;

  return (
    <>
      <p className="step-tag">Step 4 · Report</p>
      <div className="verdict-box">
        <div className="verdict-label">Agent verdict</div>
        <div className={`verdict-text ${VERDICT_CLASS[r.verdict.verdict] || ""}`}>
          {r.verdict.verdict}
        </div>
        <div className="verdict-source">
          Written from the 12 bars below — {r.verdict.source === "model" ? "composed by the agent" : "composed by rule"}
        </div>
        <div className="overall-line">
          <span className="verdict-label" style={{ margin: 0 }}>Overall</span>
          <span className="overall-num">{overall ?? "—"}</span>
          <span className="hint" style={{ margin: 0 }}>
            average of the {overall !== null ? "scored" : ""} bars (Unknown and N/A excluded)
          </span>
        </div>
      </div>

      <div className="card">
        <h2>Reasons</h2>
        <ul className="reasons">
          {r.verdict.reasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
        <div className="section-title">Not checked</div>
        <ul className="notchecked">
          {r.verdict.notChecked.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h2>The 12 bars</h2>
        <div className="bars">
          {r.barList.map((b) => (
            <div className="bar-row" key={b.key}>
              <div className="bar-head">
                <span className="name">{BAR_LABELS[b.key] || b.key}</span>
                <span className="val">
                  {typeof b.score === "number" ? `${b.score}/100` : b.score === "unknown" ? "Unknown" : "N/A"}
                </span>
              </div>
              <div className="bar-track">
                <div
                  className={`bar-fill ${fillClass(b.score)}`}
                  style={{ width: typeof b.score === "number" ? `${b.score}%` : "0%" }}
                />
              </div>
              <div className="bar-note">{b.note}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Payment and agent</h2>
        <div className="kv">
          <div>
            <div className="k">GOAT payment</div>
            <div className="v mono">
              {r.payment.txHash ? (
                <a
                  href={`https://explorer.goat.network/tx/${r.payment.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {r.payment.txHash.slice(0, 12)}…{r.payment.txHash.slice(-8)}
                </a>
              ) : (
                "—"
              )}
            </div>
          </div>
          <div>
            <div className="k">Address scanned</div>
            <div className="v mono">{order.address.slice(0, 12)}…{order.address.slice(-8)}</div>
          </div>
          <div>
            <div className="k">ERC-8004 agent registry</div>
            <div className="v mono">{r.agent.erc8004.agentRegistry}</div>
          </div>
          <div>
            <div className="k">ERC-8004 agent id</div>
            <div className="v mono">{r.agent.erc8004.agentId}</div>
          </div>
        </div>
        <p className="hint" style={{ marginTop: 14 }}>
          Public chain data only. Not financial advice.{" "}
          <a href="#" onClick={(e) => { e.preventDefault(); onRestart(); }} style={{ color: "var(--accent)" }}>
            Scan another address
          </a>
        </p>
      </div>
    </>
  );
}

function fillClass(score: number | string): string {
  if (typeof score !== "number") return "f-mute";
  if (score < 40) return "f-bad";
  if (score < 70) return "f-warn";
  return "f-good";
}
