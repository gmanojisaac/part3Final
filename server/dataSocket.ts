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
  console.log(
    `[dataSocket] ${connected ? "connected (FYERS v3 WS)" : "socket closed"}`
  );
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

/** Ensure upstream WS is subscribed to this symbol. */
export function ensureSubscribed(symbol: string) {
  if (SUBSCRIBED.has(symbol)) return;
  SUBSCRIBED.add(symbol);

  if (!socketConnected) {
    console.warn(
      `[dataSocket] ensureSubscribed(${symbol}) but socket not connected yet`
    );
  }

  console.log(`[dataSocket] → SUB ${symbol}`);
  subscribeSymbols([symbol]);
}

/** Register a listener for LTP ticks of a symbol. Returns an unsubscribe fn. */
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
    try {
      cb(cached.ltp);
    } catch (err) {
      console.error(
        `[dataSocket] immediate listener error for ${symbol}:`,
        err
      );
    }
  }

  return () => {
    const s = LISTENERS.get(symbol);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) {
      LISTENERS.delete(symbol);
      // NOTE: we do not auto-unsubscribe upstream; simple model for now.
    }
  };
}

/** Return latest known LTP for symbol, or null if none. */
export function nowLtp(symbol: string): number | null {
  const data = LAST_LTP.get(symbol);
  if (!data) return null;
  return data.ltp;
}
