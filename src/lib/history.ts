/**
 * Local scan history for the visitor, kept in localStorage on this device.
 * Gridscore keeps no server-side account of who scanned what.
 */

export interface ScanRecord {
  orderId: string;
  address: string;
  createdAt: string;
  overall: number | string | null;
  verdict: string | null;
}

const HISTORY_KEY = "gridscore:history";
const HISTORY_LIMIT = 25;

export function readHistory(): ScanRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordScan(orderId: string, address: string) {
  if (typeof window === "undefined") return;
  const list = readHistory().filter((r) => r.orderId !== orderId);
  list.unshift({ orderId, address, createdAt: new Date().toISOString(), overall: null, verdict: null });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_LIMIT)));
}

export function recordOutcome(orderId: string, overall: number | string, verdict: string) {
  if (typeof window === "undefined") return;
  const list = readHistory();
  const hit = list.find((r) => r.orderId === orderId);
  if (hit) {
    hit.overall = overall;
    hit.verdict = verdict;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_LIMIT)));
  }
}
