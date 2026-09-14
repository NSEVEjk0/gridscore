"use client";

import { useEffect, useState } from "react";
import { BackButton } from "@/components/BackButton";
import { readHistory, type ScanRecord } from "@/lib/history";

const VERDICT_CHIP: Record<string, string> = {
  "Do not interact": "vc-do-not",
  "Test with dust only": "vc-dust",
  "OK for small, known use": "vc-ok",
  "Not enough data": "vc-nodata",
};

/**
 * The visitor's scan history, kept on this device (localStorage). Each scan
 * records the address, order id, and outcome; clicking one reopens its report.
 */
export default function HistoryPage() {
  const [history, setHistory] = useState<ScanRecord[] | null>(null);
  const [outcomes, setOutcomes] = useState<
    Record<string, { overall: number | string | null; verdict: string | null }>
  >({});

  useEffect(() => {
    const list = readHistory();
    setHistory(list);
    // Refresh outcomes from the server for any unfinished records.
    for (const r of list) {
      if (r.verdict) continue;
      fetch(`/api/order/${r.orderId}`, { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((o) => {
          if (o?.report) {
            setOutcomes((prev) => ({
              ...prev,
              [r.orderId]: { overall: o.report.overall, verdict: o.report.verdict.verdict },
            }));
          }
        })
        .catch(() => {});
    }
  }, []);

  function reopen(orderId: string) {
    if (typeof window !== "undefined") {
      localStorage.setItem("gridscore:orderId", orderId);
      window.location.href = "/";
    }
  }

  return (
    <div>
      <BackButton />
      <p className="kicker">History</p>
      <h1>Your scans</h1>
      <p className="lead">
        Every scan started on this device, newest first. The list lives in this
        browser only — Gridscore keeps no account of who scanned what.
      </p>

      {history === null ? (
        <p className="hint" style={{ marginTop: 32 }}>Loading…</p>
      ) : history.length === 0 ? (
        <p className="hint" style={{ marginTop: 32 }}>
          No scans yet. Start one from the home page and it will appear here.
        </p>
      ) : (
        <div style={{ marginTop: 24 }}>
          {history.map((r, i) => {
            const outcome = outcomes[r.orderId] ?? {
              overall: r.overall,
              verdict: r.verdict,
            };
            const status = outcome.verdict ? "done" : "in progress or unpaid";
            return (
              <button
                key={r.orderId}
                type="button"
                className="history-item"
                style={{ animationDelay: `${i * 40}ms` }}
                onClick={() => reopen(r.orderId)}
              >
                <div className="hi-head">
                  <span className="mono" style={{ fontSize: ".84rem", wordBreak: "break-all" }}>
                    {r.address.slice(0, 10)}…{r.address.slice(-8)}
                  </span>
                  <span className="hi-date">{r.createdAt.slice(0, 16).replace("T", " ")}</span>
                </div>
                <div className="hi-meta">
                  {typeof outcome.overall === "number" ? `Overall ${outcome.overall}/100` : "No overall yet"} · {status}
                </div>
                {outcome.verdict ? (
                  <span className={`verdict-chip ${VERDICT_CHIP[outcome.verdict] || "vc-nodata"}`}>
                    {outcome.verdict}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
