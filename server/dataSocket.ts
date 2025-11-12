/* eslint-disable no-console */

/**
 * Lightweight market-data hub used by the state machine.
 * - Caches latest LTP per symbol
 * - Lets modules register per-symbol tick listeners via `onSymbolTick`
 * - Exposes `nowLtp(symbol)` for quick reads
 *
 * FYERS WebSocket integration:
 *   - connect() now initializes the FYERS WS (via fyersSocket.ts)
 *   - ensureSubscribed(symbol) actually calls subscribeSymbols()
 */

import { connectFyersSocket, subscribeSymbols } from "./fyersSocket";

type TickHandler = (ltp: number, raw?: unknown) => void;

const LAST_LTP = new Map<string, { ltp: number; ts: number }>();
const LISTENERS = new Map<string, Set<TickHandler>>();
const SUBSCRIBED = new Set<string>();

let socketConnected = false;

// ---- Core wiring ------------------------------------------------------------

function _hhmmss() {
  return new Date().toTimeString().slice(0, 8);
}

/** Establish upstream socket (FYERS WS) */
export async function connect(): Promise<void> {
  // Initialize upstream FYERS socket now
  await connectFyersSocket();
}

/** Called by your socket bootstrap when connection state changes */
export function setSocketConnected(connected: boolean) {
  socketConnected = connected;
  console.log(`[dataSocket] ${connected ? "connected (FYERS SDK)" : "socket closed"}`);
}

/** Push raw ticks into the hub (call this from your SDK onTick) */
export function ingestSdkTick(symbol: string, ltp: number, raw?: unknown) {
  LAST_LTP.set(symbol, { ltp, ts: Date.now() });

  const set = LISTENERS.get(symbol);
  if (set && set.size) {
    for (const cb of set) {
      try {
        cb(ltp, raw);
      } catch (err) {
        console.error(`[dataSocket] listener error for ${symbol}:`, err);
      }
    }
  }
}

/** Return latest known LTP (or null if we have none yet) */
export function nowLtp(symbol: string): number | null {
  return LAST_LTP.get(symbol)?.ltp ?? null;
}

/**
 * Register a per-symbol tick callback.
 * Returns an unsubscribe function.
 */
export function onSymbolTick(symbol: string, cb: TickHandler): () => void {
  let set = LISTENERS.get(symbol);
  if (!set) {
    set = new Set();
    LISTENERS.set(symbol, set);
  }
  set.add(cb);

  // If this is the first listener, ensure we are subscribed upstream.
  if (!SUBSCRIBED.has(symbol)) {
    ensureSubscribed(symbol);
  }

  // Emit cached LTP immediately if available.
  const cached = LAST_LTP.get(symbol);
  if (cached) {
    setTimeout(() => {
      try {
        cb(cached.ltp);
      } catch {
        /* ignore */
      }
    }, 0);
  }

  return () => {
    const s = LISTENERS.get(symbol);
    if (!s) return;
    s.delete(cb);
  };
}

/** Ask the upstream SDK to subscribe (idempotent) */
export function ensureSubscribed(symbol: string) {
  if (SUBSCRIBED.has(symbol)) return;
  SUBSCRIBED.add(symbol);
  console.log(`[dataSocket] → SUB ${symbol}`);

  // 🔗 actually subscribe upstream now
  try {
    subscribeSymbols([symbol]);
  } catch (e) {
    console.warn(`[dataSocket] upstream subscribe failed for ${symbol}:`, e);
  }
}

/** Optional helper if you want to force a subscription explicitly from other modules */
export function subscribe(symbol: string) {
  ensureSubscribed(symbol);
}

/** Testing/dev utility: inject a fake tick (e.g., from tests) */
export function injectTick(symbol: string, ltp: number, ts?: number) {
  LAST_LTP.set(symbol, { ltp, ts: ts ?? Date.now() });
  console.log(`[dataSocket] (inject) ${symbol} -> ${ltp}`);
  ingestSdkTick(symbol, ltp, { injected: true, ts: ts ?? Date.now() });
}

/** Expose last-tick map for diagnostics */
export function __peekLastTicks() {
  return new Map(LAST_LTP);
}

/** Simple heartbeat log */
export function __logReconnectAttempt(n: number) {
  console.log("trying to reconnect ", n);
}

/** Used by your SDK layer when it has actually subscribed upstream */
export function __markSubscribed(symbols: string[]) {
  for (const s of symbols) SUBSCRIBED.add(s);
}

/** Clear all runtime state */
export function __resetAll() {
  LAST_LTP.clear();
  for (const s of LISTENERS.values()) s.clear();
  LISTENERS.clear();
  SUBSCRIBED.clear();
  socketConnected = false;
}

// ---- Public facade object (legacy) -----------------------------------------

export const dataSocket = {
  connect,
  setSocketConnected,
  ingestSdkTick,
  injectTick,
  nowLtp,
  onSymbolTick,
  ensureSubscribed,
  subscribe,
  __peekLastTicks,
  __logReconnectAttempt,
  __markSubscribed,
  __resetAll,
};
