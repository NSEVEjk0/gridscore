/**
 * Worker endpoint for the web app. Defaults to localhost (web and worker on
 * the same host); set WORKER_URL when the web app runs elsewhere.
 */
export function workerUrl(): string {
  return (process.env.WORKER_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
}

export async function workerFetch(
  path: string,
  init?: RequestInit
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${workerUrl()}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    cache: "no-store",
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}
