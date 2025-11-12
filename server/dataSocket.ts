/* server/dataSocket.ts
 * FYERS official SDK wrapper (fyers-api-v3). Connects WS,
 * subscribes symbols, parses ticks, forwards to onTickFromMarket().
 *
 * Prereq:
 *   npm i fyers-api-v3 ws
 */

import path from "path";
import fs from "fs";
import { onTickFromMarket } from "./fyersClient";

// FYERS SDK is CommonJS without TS types.
const { fyersDataSocket: DataSocket } = require("fyers-api-v3");

function ensureDir(p?: string) {
  if (!p) return undefined;
  const abs = path.resolve(p);
  try {
    fs.mkdirSync(abs, { recursive: true });
    return abs;
  } catch (e: any) {
    console.warn("[dataSocket] cannot create log dir:", abs, e?.message || e);
    return undefined;
  }
}

function parseTickMessage(msg: any): Array<{ symbol: string; ltp: number; ts?: number }> {
  const out: Array<{ symbol: string; ltp: number; ts?: number }> = [];
  if (!msg) return out;

  // SDK usually sends strings → parse JSON
  if (typeof msg === "string") {
    try { msg = JSON.parse(msg); } catch { return out; }
  }

  // Batch: { d: [ { s:"NSE:...", v:{ lp:123.4, tt: 1731300000000 } }, ... ] }
  if (Array.isArray(msg?.d)) {
    for (const row of msg.d) {
      const s = row?.s || row?.symbol;
      const lp = row?.v?.lp ?? row?.v?.ltp ?? row?.ltp ?? row?.lp;
      const tt = row?.v?.tt ?? row?.tt;
      if (s && lp != null && Number.isFinite(Number(lp))) {
        out.push({ symbol: String(s), ltp: Number(lp), ts: typeof tt === "number" ? tt : undefined });
      }
    }
    return out;
  }

  // Lite: { symbol:"NSE:...", ltp:123.4, ts?: 173130... }
  if (msg?.symbol && (msg?.ltp != null || msg?.lp != null)) {
    const s = String(msg.symbol);
    const lp = Number(msg.ltp ?? msg.lp);
    if (Number.isFinite(lp)) out.push({ symbol: s, ltp: lp, ts: typeof msg.ts === "number" ? msg.ts : undefined });
    return out;
  }

  return out;
}

class FyersDataSocketWrapper {
  private skt: any = null;
  private connected = false;
  private wantSymbols = new Set<string>();

  async connect() {
    const APPID = (process.env.FYERS_APP_ID || "").trim();
    const RAW = (process.env.FYERS_ACCESS_TOKEN || "").trim();
    if (!APPID || !RAW) {
      console.warn("[dataSocket] FYERS_APP_ID / FYERS_ACCESS_TOKEN missing; live data will not stream.");
      return;
    }

    const accessToken = `${APPID}:${RAW}`;
    const logPath = ensureDir(process.env.FYERS_LOG_PATH || "");

    try {
      // Pass logPath only if available; otherwise SDK tries to write and fails
      this.skt = logPath ? DataSocket.getInstance(accessToken, logPath) : DataSocket.getInstance(accessToken);
    } catch (e: any) {
      console.error("[dataSocket] getInstance error:", e?.message || e);
      return;
    }

    this.skt.on("connect", () => {
      this.connected = true;
      console.log("[dataSocket] connected (FYERS SDK)");
      if (this.wantSymbols.size) {
        const subs = Array.from(this.wantSymbols);
        try {
          this.skt.subscribe(subs);
          console.log("[dataSocket] → SUB", subs.join(", "));
        } catch (e: any) {
          console.error("[dataSocket] subscribe error:", e?.message || e);
        }
      }
    });

    this.skt.on("message", (message: any) => {
      const ticks = parseTickMessage(message);
      for (const t of ticks) {
        onTickFromMarket(t.symbol, t.ltp, t.ts ?? Date.now());
      }
    });

    this.skt.on("error", (err: any) => {
      console.warn("[dataSocket] error:", err?.message || err);
    });

    this.skt.on("close", () => {
      this.connected = false;
      console.warn("[dataSocket] socket closed");
      // SDK will reconnect if enabled
    });

    try {
      this.skt.connect();
      this.skt.autoreconnect();
    } catch (e: any) {
      console.error("[dataSocket] connect/autoreconnect error:", e?.message || e);
    }
  }

  /** Subscribe a FYERS symbol, e.g. "NSE:NIFTY25N1125600CE" */
  async subscribe(symbol: string) {
    this.wantSymbols.add(symbol);
    if (this.connected && this.skt) {
      try {
        this.skt.subscribe([symbol]);
        console.log("[dataSocket] → SUB", symbol);
      } catch (e: any) {
        console.error("[dataSocket] subscribe error:", e?.message || e);
      }
    }
  }

  /** Dev/test helper used by sanity scripts */
  injectTick(symbol: string, ltp: number, ts: number) {
    onTickFromMarket(symbol, ltp, ts);
  }
}

export const dataSocket = new FyersDataSocketWrapper();
