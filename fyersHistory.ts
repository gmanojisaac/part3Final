// fyersHistory.ts — 1-minute history via FYERS (SDK or REST via getHistory wrapper)
// Exports: fetchHistoryCandles, candlesToTicks, getHistoryGaps, Candle, HistoryOpts

import type { Tick } from "./types";
import { getHistory, type HistoryInput } from "./fyersClient";

export type Candle = { t: number; o: number; h: number; l: number; c: number; v?: number };

export type HistoryOpts = {
  sliceMins?: number;           // slice width in minutes for batched fetching
  maxRetries?: number;          // retries per sub-request
  maxAttemptsPerSlice?: number; // halve slice this many times
  baseWaitMs?: number;          // backoff base wait
  jitterMs?: number;            // random jitter for backoff
  pauseBetweenSlicesMs?: number;
  allowSkipFinal?: boolean;     // skip unrecoverable tiny slices instead of throw
  rescueSpanMins?: number;      // extra minutes around failed window to rescue
  verbose?: boolean;            // detailed logs
};

function toSec(d: Date) { return Math.floor(d.getTime() / 1000); }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// ---- Gap tracking ----
type Gap = { symbol: string; from: string; to: string; reason: string };
const gaps: Gap[] = [];
export function getHistoryGaps(): Gap[] { return gaps.slice(); }

// ---- Env tick style ----
function getTickStyle(): "close" | "ohlcPath" {
  const raw = (process.env.TICK_STYLE || "").trim().toLowerCase();
  return raw === "ohlcpath" ? "ohlcPath" : "close";
}

// ---- Single call wrapper (always 1-minute resolution) ----
async function tryHistoryOnce(symbol: string, aFrom: Date, aTo: Date): Promise<Candle[]> {
  const inp: HistoryInput = {
    symbol,
    resolution: "1",
    date_format: "0",
    range_from: String(toSec(aFrom)),
    range_to:   String(toSec(aTo)),
    cont_flag: "1",
  };
  const res = await getHistory(inp);
  const arr: any[] = res?.candles ?? res?.data ?? [];
  return arr.map((row: any) => {
    const [t, o, h, l, c, v] = row;
    return { t, o, h, l, c, v } as Candle;
  });
}

// ---- Robust fetcher with halving + rescue ----
export async function fetchHistoryCandles(
  symbol: string,
  from: Date,
  to: Date,
  opts: HistoryOpts = {}
): Promise<Candle[]> {
  const {
    sliceMins = 30,
    maxRetries = 5,
    maxAttemptsPerSlice = 6,
    baseWaitMs = 1200,
    jitterMs = 600,
    pauseBetweenSlicesMs = 200,
    allowSkipFinal = true,
    rescueSpanMins = 60,
    verbose = false,
  } = opts;

  const all: Candle[] = [];
  let cur = new Date(from);

  while (cur < to) {
    const sliceEnd = new Date(Math.min(cur.getTime() + sliceMins * 60_000, to.getTime()));
    let aFrom = new Date(cur);
    let aTo = new Date(sliceEnd);
    let attempts = 0;
    let ok = false;
    let curSliceMins = sliceMins;

    while (attempts < maxAttemptsPerSlice) {
      attempts++;
      try {
        const got = await tryHistoryOnce(symbol, aFrom, aTo);
        all.push(...got);
        ok = true;
        break;
      } catch (e: any) {
        const status = Number(String(e?.message).match(/^\d+/)?.[0] || 0);
        const transient = [429, 500, 502, 503, 504].includes(status);
        if (transient && attempts < maxRetries) {
          const wait = Math.min(baseWaitMs * 2 ** (attempts - 1), 20_000) + Math.floor(Math.random() * jitterMs);
          if (verbose) console.warn(
            `History slice ${aFrom.toISOString()}→${aTo.toISOString()} failed ${status || "ERR"}. ` +
            `Retry ${attempts}/${maxRetries} in ${wait}ms...`
          );
          await sleep(wait);
          continue;
        }
        const spanMs = aTo.getTime() - aFrom.getTime();
        if (spanMs <= 60_000) break; // already at 1 minute
        curSliceMins = Math.max(1, Math.floor(curSliceMins / 2));
        aTo = new Date(aFrom.getTime() + curSliceMins * 60_000);
        if (verbose) console.warn(`Halving slice → ${aFrom.toISOString()}→${aTo.toISOString()}`);
      }
    }

    if (!ok) {
      // Rescue: fetch a wider band and filter back to the tiny window
      const rescueFrom = new Date(aFrom.getTime() - rescueSpanMins * 60_000);
      const rescueTo   = new Date(aTo.getTime()   + rescueSpanMins * 60_000);
      if (verbose) console.warn(`RESCUE ${symbol}: ${rescueFrom.toISOString()} → ${rescueTo.toISOString()}`);
      try {
        const rescue = await tryHistoryOnce(symbol, rescueFrom, rescueTo);
        const filtered = rescue.filter(c => {
          const ts = c.t * 1000;
          return ts >= aFrom.getTime() && ts <= aTo.getTime();
        });
        if (filtered.length) {
          if (verbose) console.warn(
            `RESCUE succeeded: ${filtered.length} candle(s) for ${aFrom.toISOString()}→${aTo.toISOString()}`
          );
          all.push(...filtered);
          cur = new Date(sliceEnd);
          await sleep(pauseBetweenSlicesMs);
          continue;
        }
      } catch (err) {
        if (verbose) console.error(`RESCUE failed for ${symbol}:`, (err as Error).message);
      }

      const reason = `Persistent failure (even with rescue ${rescueSpanMins}m)`;
      gaps.push({ symbol, from: aFrom.toISOString(), to: aTo.toISOString(), reason });
      console.error(`GAP [${symbol}]: ${aFrom.toISOString()} → ${aTo.toISOString()} (${reason})`);
      if (!allowSkipFinal) throw new Error(`Giving up unrecoverable slice ${aFrom.toISOString()}→${aTo.toISOString()}`);
      cur = new Date(aTo);
    } else {
      cur = new Date(sliceEnd);
    }

    await sleep(pauseBetweenSlicesMs);
  }

  // De-dup + sort
  const seen = new Set<number>();
  const dedup: Candle[] = [];
  for (const c of all) {
    if (!seen.has(c.t)) { seen.add(c.t); dedup.push(c); }
  }
  dedup.sort((a, b) => a.t - b.t);
  return dedup;
}

// ---- Candle → Tick (uses env TICK_STYLE) ----
export function candlesToTicks(symbol: string, candles: Candle[]): Tick[] {
  const policy = getTickStyle();
  const ticks: Tick[] = [];
  for (const k of candles) {
    const base = k.t * 1000;
    if (policy === "close") {
      ticks.push({ time: new Date(base + 59_000), symbol, ltp: k.c });
    } else {
      // synthetic O→L→H→C within the minute (still 1m data)
      ticks.push({ time: new Date(base + 10), symbol, ltp: k.o });
      ticks.push({ time: new Date(base + 20), symbol, ltp: k.l });
      ticks.push({ time: new Date(base + 30), symbol, ltp: k.h });
      ticks.push({ time: new Date(base + 59_000), symbol, ltp: k.c });
    }
  }
  return ticks.sort((a, b) => a.time.getTime() - b.time.getTime());
}
