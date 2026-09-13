import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Tiny durable order store: one JSON object per line in a state file
 * (data/state.jsonl, or GRIDSCORE_STATE_FILE). On boot the file is replayed
 * in order; later lines for the same id win. Good enough for a
 * single-writer worker process.
 */

const STATE_FILE = process.env.GRIDSCORE_STATE_FILE || "data/state.jsonl";

export class Store {
  constructor(path = STATE_FILE) {
    this.path = path;
    this.orders = new Map();
    this.usedTxHashes = new Set();
    mkdirSync(dirname(this.path) || ".", { recursive: true });
    this.#replay();
  }

  #replay() {
    if (!existsSync(this.path)) return;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t);
        if (rec.type === "order") {
          this.orders.set(rec.order.id, rec.order);
          if (rec.order.payment?.txHash) {
            this.usedTxHashes.add(rec.order.payment.txHash.toLowerCase());
          }
        }
      } catch {
        // skip corrupt lines
      }
    }
  }

  put(order) {
    this.orders.set(order.id, order);
    if (order.payment?.txHash) {
      this.usedTxHashes.add(order.payment.txHash.toLowerCase());
    }
    appendFileSync(this.path, JSON.stringify({ type: "order", order }) + "\n");
  }

  get(id) {
    return this.orders.get(id) || null;
  }

  txUsed(txHash) {
    return this.usedTxHashes.has(String(txHash).toLowerCase());
  }
}

export function newOrderId() {
  return (
    "gs_" +
    Array.from({ length: 12 }, () =>
      "0123456789abcdefghjkmnpqrstuvwxyz"[Math.floor(Math.random() * 32)]
    ).join("")
  );
}
