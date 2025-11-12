/* eslint-disable no-console */

/**
 * Simple relay registry + broadcaster.
 *
 * ENV:
 *  - RELAY_URLS: comma-separated list of base URLs (e.g. "https://a.ngrok.app,https://b.ngrok.app")
 *  - RELAY_PATH: path to append when posting (default: "/webhook")
 *  - RELAY_TIMEOUT_MS: per-relay timeout in ms (default: 3000)
 */

const DEFAULT_PATH = (process.env.RELAY_PATH ?? "/webhook").toString();
const DEFAULT_TIMEOUT = Number(process.env.RELAY_TIMEOUT_MS ?? 3000);

// In-memory list of relay base URLs (no trailing slash preferred)
let RELAYS: string[] = (process.env.RELAY_URLS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// ---- Public API -------------------------------------------------------------

export function getRelays(): string[] {
  return [...RELAYS];
}

export function setRelays(urls: string[]) {
  RELAYS = [...new Set(urls.map(normalizeBase))];
}

export function addRelay(url: string) {
  const base = normalizeBase(url);
  if (!RELAYS.includes(base)) RELAYS.push(base);
}

export function removeRelay(url: string) {
  const base = normalizeBase(url);
  RELAYS = RELAYS.filter(u => u !== base);
}

/**
 * Broadcasts the payload to all configured relays.
 * Returns an object summarizing results.
 */
export async function relayToAll(
  payload: string,
  options?: { path?: string; timeoutMs?: number; headers?: Record<string, string> }
): Promise<{
  okCount: number;
  failCount: number;
  results: Array<{ url: string; status: number; ok: boolean; error?: string }>;
}> {
  const path = options?.path ?? DEFAULT_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT;
  const headers = { "content-type": "text/plain; charset=utf-8", ...(options?.headers ?? {}) };

  const relays = getRelays();
  if (relays.length === 0) {
    return { okCount: 0, failCount: 0, results: [] };
  }

  const results: Array<{ url: string; status: number; ok: boolean; error?: string }> = [];

  await Promise.all(
    relays.map(async base => {
      const url = joinUrl(base, path);
      try {
        const { ok, status } = await postWithTimeout(url, payload, headers, timeoutMs);
        if (!ok) {
          console.warn(`[relay] -> ${url} : HTTP ${status}`);
        } else {
          console.log(`[relay] -> ${url} : HTTP ${status}`);
        }
        results.push({ url, status, ok });
      } catch (err: any) {
        console.warn(`[relay] -> ${url} : ERROR ${err?.message ?? err}`);
        results.push({ url, status: 0, ok: false, error: err?.message ?? String(err) });
      }
    })
  );

  const okCount = results.filter(r => r.ok).length;
  const failCount = results.length - okCount;

  return { okCount, failCount, results };
}

// ---- Internals --------------------------------------------------------------

function normalizeBase(u: string): string {
  let s = u.trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  // remove trailing slash
  if (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function joinUrl(base: string, path: string): string {
  if (!path) return base;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  const p = path.startsWith("/") ? path : `/${path}`;
  return base + p;
}

async function postWithTimeout(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ ok: boolean; status: number }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    // Node 18+ has global fetch
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: ctrl.signal,
    });
    return { ok: resp.ok, status: resp.status };
  } finally {
    clearTimeout(t);
  }
}
