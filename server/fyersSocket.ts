/* eslint-disable no-console */

/**
 * FYERS WebSocket adapter using fyers-api-v3 (fyersDataSocket).
 *
 * ENV (required):
 *   FYERS_ACCESS_TOKEN = "<APP_ID>:<USER_ACCESS_TOKEN>"
 *
 * ENV (optional):
 *   FYERS_WS_LOG_PATH  = "path/where/logs/to/be/saved"  (default: "./")
 *
 * Exposes:
 *   - connectFyersSocket(): Promise<void>
 *   - subscribeSymbols(symbols: string[]): Promise<void>
 *   - isFyersSocketConnected(): boolean
 *
 * This file plugs into dataSocket.ts which calls connectFyersSocket() and subscribeSymbols().
 */

import { setSocketConnected, ingestSdkTick } from "./dataSocket";

// Lazy require so TypeScript compiles even if the package isn't installed yet
let DataSocketCtor: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("fyers-api-v3");
  DataSocketCtor = mod?.fyersDataSocket ?? mod?.fyersDataSocketV2 ?? null;
} catch {
  // keep null; we'll warn at connect time
}

const ACCESS_TOKEN = (process.env.FYERS_ACCESS_TOKEN ?? "").trim();
const LOG_PATH = (process.env.FYERS_WS_LOG_PATH ?? "./").trim();

// Upstream socket instance
let skt: any = null;
let connected = false;
let connecting = false;

// Keep the desired subscription set for resubscribe after reconnect
const SUBS = new Set<string>();

// Queue symbols requested before the socket is ready
let pendingSymbols: string[] = [];

// Debounce upstream subscribe calls to avoid spamming the server
let subscribeDebounceTimer: NodeJS.Timeout | null = null;
const SUBSCRIBE_DEBOUNCE_MS = 150;

function log(...a: any[]) {
  console.log("[fyersSocket]", ...a);
}
function warn(...a: any[]) {
  console.warn("[fyersSocket]", ...a);
}
function err(...a: any[]) {
  console.error("[fyersSocket]", ...a);
}

export function isFyersSocketConnected() {
  return connected;
}

/** Open the FYERS WS and wire events */
export async function connectFyersSocket(): Promise<void> {
  if (connected || connecting) return;
  if (!ACCESS_TOKEN) {
    warn("FYERS_ACCESS_TOKEN missing — cannot start WS.");
    return;
  }
  if (!DataSocketCtor) {
    err("Package 'fyers-api-v3' not found. Run: npm i fyers-api-v3");
    return;
  }

  connecting = true;
  try {
    // Model from your snippet:
    // const DataSocket = require("fyers-api-v3").fyersDataSocket
    // var skt= DataSocket.getInstance(accesstoken,"path/where/logs/to/be/saved")
    // ...
    const DataSocket = DataSocketCtor;
    skt = DataSocket.getInstance(ACCESS_TOKEN, LOG_PATH);

    // Events
    skt.on("connect", () => {
      connected = true;
      connecting = false;
      setSocketConnected(true);
      log("✅ connected (fyers-api-v3)");

      // Resubscribe everything we know + anything queued
      const toSub = Array.from(new Set<string>([...SUBS, ...pendingSymbols]));
      pendingSymbols = [];
      if (toSub.length) {
        trySubscribe(toSub);
      }
    });

    skt.on("message", (message: any) => {
      // Your snippet shows raw message logging. We normalize and push to ingestSdkTick.
      handleIncomingMessage(message);
    });

    skt.on("error", (message: any) => {
      err("❌ error:", message?.message ?? message);
    });

    skt.on("close", () => {
      if (connected) warn("🔌 socket closed");
      connected = false;
      setSocketConnected(false);
      // autoreconnect is enabled below; we'll re-subscribe on next connect
    });

    // Connect and enable autoreconnect
    skt.connect();
    if (typeof skt.autoreconnect === "function") {
      skt.autoreconnect();
    }
  } catch (e) {
    connecting = false;
    err("connectFyersSocket failed:", (e as any)?.message ?? e);
  }
}

/** Subscribe one or more symbols for live ticks */
export async function subscribeSymbols(symbols: string[]): Promise<void> {
  if (!symbols || symbols.length === 0) return;
  for (const s of symbols) SUBS.add(s);

  // If not connected yet, queue and ensure connection
  if (!connected || !skt) {
    pendingSymbols.push(...symbols);
    if (!connecting) {
      connectFyersSocket().catch(() => {});
    }
    return;
  }

  // Connected → debounce/batch subscribe
  if (subscribeDebounceTimer) clearTimeout(subscribeDebounceTimer);
  subscribeDebounceTimer = setTimeout(() => {
    const arr = Array.from(SUBS);
    trySubscribe(arr);
  }, SUBSCRIBE_DEBOUNCE_MS);
}

// ---- internals --------------------------------------------------------------

function trySubscribe(all: string[]) {
  if (!skt || !connected) return;
  if (!all.length) return;

  // Fyers WS can handle an array; chunk defensively if you later need
  const CHUNK = 100;
  for (let i = 0; i < all.length; i += CHUNK) {
    const chunk = all.slice(i, i + CHUNK);
    try {
      skt.subscribe(chunk);
      log(`subscribing ${chunk.length} symbols`);
    } catch (e) {
      err("subscribe error:", (e as any)?.message ?? e);
    }
  }
}

function handleIncomingMessage(message: any) {
  // The client may deliver strings or objects. Normalize to objects/arrays.
  let payload: any = message;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      // Non-JSON strings, just log & skip
      log("message (string)", payload.slice(0, 160));
      return;
    }
  }

  // Try common FYERS shapes:
  // - { symbol, ltp, ... }
  // - { d: [ { v: { symbol, ltp, ... }}, ... ] }
  // - [ { symbol, ltp }, ... ]
  const rows: any[] = Array.isArray(payload?.d)
    ? payload.d
    : Array.isArray(payload)
    ? payload
    : [payload];

  for (const row of rows) {
    const v = row?.v ?? row;

    const symbol: string | undefined =
      v?.symbol ?? v?.sym ?? v?.code ?? v?.symbolName;

    const ltp = [
      v?.ltp,
      v?.lp,
      v?.price,
      v?.P,
      v?.lastPrice,
      v?.closePrice,
    ]
      .map(Number)
      .find((n) => Number.isFinite(n));

    if (symbol && Number.isFinite(ltp)) {
      ingestSdkTick(String(symbol), Number(ltp), v);
    }
  }
}
