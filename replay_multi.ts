// replay_multi.ts — multi-symbol, multi-day replay using FYERS 1m history
// Run:  npx ts-node replay_multi.ts ./TradingView_Alerts.csv
//
// Env controls:
//   FYERS_ACCESS_TOKEN or fyers_token.txt   (raw token OK; 'Bearer ' auto-added)
//   TICK_STYLE=close | ohlcPath             (default: close)
// Optional (in code): adjust TRADING_FROM_Z / TRADING_TO_Z if needed.

import fs from "node:fs";
import path from "node:path";
import { candlesToTicks, fetchHistoryCandles, getHistoryGaps } from "./fyersHistory";
import { runSimulation } from "./simulator";
import { mergeTicksAndSignals } from "./signals";
import type { Tick } from "./types";

// —— Trading session window (UTC/“Z”). Adjust to your preference ——
// NSE equity/FO regular: 09:15–15:30 IST ≈ 03:45–10:00Z
// We keep a wider window to be safe with alerts (pre/post): 09:00–16:00 IST ≈ 03:30–10:30Z
const TRADING_FROM_Z = "03:30:00Z";
const TRADING_TO_Z   = "10:30:00Z";

// ---------- Parse TradingView CSV ----------
type Row = { time: Date; symbol: string; signal: "BUY" | "SELL" };

/** Split a CSV line while respecting quotes and escaped quotes. */
function splitCSVLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else { q = !q; }
    } else if (ch === "," && !q) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * TradingView export headers commonly look like:
 *   Alert ID, Ticker, Name, Description, Time
 * We only use Description (to infer sym=... and BUY/SELL) and Time.
 * If sym=... missing, we fallback to the Ticker column (taking the part before the first comma).
 */
function parseTradingViewCSV(file: string): Row[] {
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = splitCSVLine(lines[0]).map((s) => s.trim());
  const iDesc = headers.findIndex((h) => /desc/i.test(h));
  const iTime = headers.findIndex((h) => /^time$/i.test(h));
  const iTicker = headers.findIndex((h) => /^ticker$/i.test(h));
  if (iDesc < 0 || iTime < 0) {
    throw new Error("CSV needs Description and Time columns");
  }

  const out: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCSVLine(lines[i]);
    const desc = (cells[iDesc] || "").trim();
    const timeStr = (cells[iTime] || "").trim();
    const ticker = iTicker >= 0 ? (cells[iTicker] || "").trim() : "";
    if (!timeStr) continue;

    // Detect side
    const isBuy = /accepted\s*entry/i.test(desc) || /buy\s*signal/i.test(desc) || /signal:\s*BUY/i.test(desc);
    const isSell = /accepted\s*exit/i.test(desc) || /sell\s*signal/i.test(desc) || /signal:\s*SELL/i.test(desc);
    const side = isBuy ? "BUY" : isSell ? "SELL" : null;
    if (!side) continue;

    // Extract symbol: prefer sym=... in Description
    let symbol = "";
    const m = desc.match(/sym\s*=\s*([^\s|,]+)/i) || desc.match(/sym\s*:\s*([^\s|,]+)/i);
    if (m) {
      symbol = m[1];
      // If no exchange prefix but Ticker has it, borrow exchange (e.g., "NSE:")
      if (!/^[A-Z]+:/.test(symbol) && ticker.includes(":")) {
        const ex = ticker.split(":")[0];
        symbol = `${ex}:${symbol}`;
      }
    } else if (ticker) {
      // Ticker can include timeframe after a comma ("NSE:SYMBOL, 1m") — take before comma
      symbol = ticker.split(",")[0].trim();
    }
    if (!symbol) continue;

    out.push({ time: new Date(timeStr), symbol, signal: side });
  }

  return out.sort((a, b) => a.time.getTime() - b.time.getTime());
}

// ---------- Helpers ----------
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type SymbolDayKey = string; // `${symbol}|${dateISO}`

/** Group signals by date → symbols on that date. */
function indexSignalsByDate(signals: Row[]): Map<string, Row[]> {
  const byDate = new Map<string, Row[]>();
  for (const s of signals) {
    const key = isoDate(s.time);
    const arr = byDate.get(key) ?? [];
    arr.push(s);
    byDate.set(key, arr);
  }
  return byDate;
}

/** Merge ticks & signals for one symbol. */
function mergeForSymbol(ticks: Tick[], signals: Row[], symbol: string): Tick[] {
  const symTicks = ticks;
  const symSignals = signals.filter((s) => s.symbol === symbol);
  return mergeTicksAndSignals(symTicks, symSignals);
}

// ---------- Main ----------
(async function main() {
  const csv = process.argv[2];
  if (!csv) {
    console.error("Usage: ts-node replay_multi.ts <TradingView_Alerts.csv>");
    process.exit(1);
  }

  const abs = path.resolve(process.cwd(), csv);
  const signals = parseTradingViewCSV(abs);
  if (!signals.length) throw new Error("No signals found in CSV");

  // Group by trading date
  const byDate = indexSignalsByDate(signals);
  const allSymbols = Array.from(new Set(signals.map((s) => s.symbol)));
  console.log(`Found ${allSymbols.length} symbol(s) across ${byDate.size} day(s).`);

  // Aggregate P&L across days
  const grandBySymbol: Record<string, { pnl: number; trades: number }> = {};
  let grandTotal = 0;

  for (const [dateISO, daySignals] of Array.from(byDate.entries()).sort()) {
    const symbols = Array.from(new Set(daySignals.map((s) => s.symbol)));
    console.log(`\n=== ${dateISO} — symbols: ${symbols.join(", ")} ===`);

    // Trading window for the day
    const from = new Date(`${dateISO}T${TRADING_FROM_Z}`);
    const to = new Date(`${dateISO}T${TRADING_TO_Z}`);

    // 1) Download all history per symbol in parallel (FYERS 1m, robust fetcher)
    const historyBySymbol = await Promise.all(
      symbols.map(async (sym) => {
        const candles = await fetchHistoryCandles(sym, from, to, {
          // interval is locked to "1" inside fyersHistory.ts
          sliceMins: 20,
          maxRetries: 5,
          maxAttemptsPerSlice: 6,
          baseWaitMs: 1200,
          jitterMs: 600,
          pauseBetweenSlicesMs: 200,
          allowSkipFinal: true,
        });
        const ticks = candlesToTicks(sym, candles); // uses env TICK_STYLE
        return [sym, ticks] as const;
      })
    );

    const tickMap = new Map<string, Tick[]>(historyBySymbol);

    // 2) Merge signals into each symbol’s tick stream
    const mergedAll: Tick[] = [];
    for (const sym of symbols) {
      const ticks = tickMap.get(sym) || [];
      const merged = mergeForSymbol(ticks, daySignals, sym);
      mergedAll.push(...merged);
    }

    // 3) Run simulation for the day
    mergedAll.sort((a, b) => a.time.getTime() - b.time.getTime());
    const dayResult = runSimulation(mergedAll, { qty: 50, cooldownSecs: 60 });

    // 4) Print P&L table for the day
    console.log(`\nP&L — ${dateISO}`);
    console.table(dayResult.bySymbol);
    const dayTotal = Object.values(dayResult.bySymbol).reduce((s, x) => s + x.pnl, 0);
    console.log(`DAY TOTAL: ${dayTotal.toFixed(2)}`);

    // 5) Accumulate into grand totals
    for (const [sym, row] of Object.entries(dayResult.bySymbol)) {
      grandBySymbol[sym] ??= { pnl: 0, trades: 0 };
      grandBySymbol[sym].pnl += row.pnl;
      grandBySymbol[sym].trades += row.trades;
    }
    grandTotal += dayTotal;
  }

  // Report history gaps (if any)
  const gaps = getHistoryGaps();
  if (gaps.length) {
    console.warn("\n=== HISTORY GAPS (skipped windows) ===");
    for (const g of gaps) console.warn(`[${g.symbol}] ${g.from} → ${g.to} :: ${g.reason}`);
  }

  // Final totals
  console.log("\n=== GRAND TOTAL P&L ===");
  console.table(grandBySymbol);
  console.log(`TOTAL P&L: ${grandTotal.toFixed(2)}`);

  // Remind tick style
  const tickEnv = (process.env.TICK_STYLE || "close").toLowerCase();
  console.log(`\nTick style: ${tickEnv === "ohlcpath" ? "ohlcPath (O→L→H→C per minute)" : "close (1 tick / minute)"}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
// replay_multi.ts — multi-symbol, multi-day replay with TV→FYERS conversion for index options
// Run:  npx ts-node replay_multi.ts ./TradingView_Alerts.csv
import fs from "node:fs";
import path from "node:path";
import { candlesToTicks, fetchHistoryCandles, getHistoryGaps } from "./fyersHistory";
import { runSimulation } from "./simulator";
import { mergeTicksAndSignals } from "./signals";
import type { Tick } from "./types";
import { tvIndexOptionToFyers, isTvIndexOption } from "./symbolMap";

const TRADING_FROM_Z = "03:30:00Z"; // ~09:00 IST
const TRADING_TO_Z   = "10:30:00Z"; // ~16:00 IST

type Row = { time: Date; symbol: string; signal: "BUY" | "SELL" };

function splitCSVLine(line: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur); return out;
}

function parseTradingViewCSV(file: string): Row[] {
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = splitCSVLine(lines[0]).map((s) => s.trim());
  const iDesc = headers.findIndex((h) => /desc/i.test(h));
  const iTime = headers.findIndex((h) => /^time$/i.test(h));
  const iTicker = headers.findIndex((h) => /^ticker$/i.test(h));
  if (iDesc < 0 || iTime < 0) throw new Error("CSV needs Description and Time columns");

  const out: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCSVLine(lines[i]);
    const desc = (cells[iDesc] || "").trim();
    const timeStr = (cells[iTime] || "").trim();
    const ticker = iTicker >= 0 ? (cells[iTicker] || "").trim() : "";
    if (!timeStr) continue;

    const isBuy = /accepted\s*entry/i.test(desc) || /buy\s*signal/i.test(desc) || /signal:\s*BUY/i.test(desc);
    const isSell = /accepted\s*exit/i.test(desc)  || /sell\s*signal/i.test(desc) || /signal:\s*SELL/i.test(desc);
    const side = isBuy ? "BUY" : isSell ? "SELL" : null;
    if (!side) continue;

    // TradingView symbol from desc/ticker
    let tvSymbol = "";
    const m = desc.match(/sym\s*[:=]\s*([^\s|,]+)/i);
    if (m) {
      tvSymbol = m[1];
      if (!/^[A-Z]+:/.test(tvSymbol) && ticker.includes(":")) {
        const ex = ticker.split(":")[0];
        tvSymbol = `${ex}:${tvSymbol}`;
      }
    } else if (ticker) {
      tvSymbol = ticker.split(",")[0].trim();
    }
    if (!tvSymbol) continue;

    out.push({ time: new Date(timeStr), symbol: tvSymbol, signal: side });
  }
  return out.sort((a, b) => a.time.getTime() - b.time.getTime());
}

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }

function indexSignalsByDate(signals: Row[]): Map<string, Row[]> {
  const byDate = new Map<string, Row[]>();
  for (const s of signals) {
    const key = isoDate(s.time);
    const arr = byDate.get(key) ?? [];
    arr.push(s);
    byDate.set(key, arr);
  }
  return byDate;
}

function mergeForSymbol(ticks: Tick[], signals: Row[], symbol: string): Tick[] {
  const symSignals = signals.filter((s) => s.symbol === symbol);
  return mergeTicksAndSignals(ticks, symSignals);
}

(async function main() {
  const csv = process.argv[2];
  if (!csv) { console.error("Usage: ts-node replay_multi.ts <TradingView_Alerts.csv>"); process.exit(1); }
  const abs = path.resolve(process.cwd(), csv);

  const signals = parseTradingViewCSV(abs);
  if (!signals.length) throw new Error("No signals found in CSV");

  const byDate = indexSignalsByDate(signals);
  const allSymbolsTv = Array.from(new Set(signals.map((s) => s.symbol)));
  console.log(`Found ${allSymbolsTv.length} TV symbol(s) across ${byDate.size} day(s).`);

  const grandBySymbol: Record<string, { pnl: number; trades: number }> = {};
  let grandTotal = 0;

  for (const [dateISO, daySignals] of Array.from(byDate.entries()).sort()) {
    // Convert each day's symbols from TV → FYERS if needed (use first occurrence time to probe)
    const daySymbolsTv = Array.from(new Set(daySignals.map((s) => s.symbol)));
    const normalizedSymbols: string[] = [];
    for (const s of daySymbolsTv) {
      if (isTvIndexOption(s)) {
        const when = daySignals.find(x => x.symbol === s)?.time ?? new Date(`${dateISO}T03:30:00Z`);
        const fy = await tvIndexOptionToFyers(s, when);
        normalizedSymbols.push(fy || s);
      } else {
        normalizedSymbols.push(s);
      }
    }

    console.log(`\n=== ${dateISO} — symbols:`);
    for (let i = 0; i < daySymbolsTv.length; i++) {
      const tv = daySymbolsTv[i];
      const fy = normalizedSymbols[i];
      console.log(`  TV: ${tv}  →  FYERS: ${fy}`);
    }

    const from = new Date(`${dateISO}T${TRADING_FROM_Z}`);
    const to   = new Date(`${dateISO}T${TRADING_TO_Z}`);

    // Download all histories in parallel (FYERS 1m) for normalized (FYERS) symbols
    const historyBySymbol = await Promise.all(
      normalizedSymbols.map(async (sym) => {
        const candles = await fetchHistoryCandles(sym, from, to, {
          sliceMins: 20,
          maxRetries: 5,
          maxAttemptsPerSlice: 6,
          baseWaitMs: 1200,
          jitterMs: 600,
          pauseBetweenSlicesMs: 200,
          allowSkipFinal: true,
        });
        const ticks = candlesToTicks(sym, candles); // uses env TICK_STYLE
        return [sym, ticks] as const;
      })
    );
    const tickMap = new Map<string, Tick[]>(historyBySymbol);

    // Merge signals (still referencing the original TV symbols for matching times/sides)
    // Map TV → FYERS for this day so we know where to attach signals
    const tvToFyers = new Map<string, string>();
    for (let i = 0; i < daySymbolsTv.length; i++) tvToFyers.set(daySymbolsTv[i], normalizedSymbols[i]);

    const mergedAll: Tick[] = [];
    for (const tv of daySymbolsTv) {
      const fy = tvToFyers.get(tv) || tv;
      const ticks = tickMap.get(fy) || [];
      // Rewrite the Row.symbol to the FYERS symbol for merging on the tick stream
      const dayRowsForTv = daySignals
        .filter(s => s.symbol === tv)
        .map(s => ({ ...s, symbol: fy }));
      const merged = mergeForSymbol(ticks, dayRowsForTv, fy);
      mergedAll.push(...merged);
    }

    mergedAll.sort((a, b) => a.time.getTime() - b.time.getTime());
    const dayResult = runSimulation(mergedAll, { qty: 50, cooldownSecs: 60 });

    console.log(`\nP&L — ${dateISO}`);
    console.table(dayResult.bySymbol);
    const dayTotal = Object.values(dayResult.bySymbol).reduce((s, x) => s + x.pnl, 0);
    console.log(`DAY TOTAL: ${dayTotal.toFixed(2)}`);

    for (const [sym, row] of Object.entries(dayResult.bySymbol)) {
      grandBySymbol[sym] ??= { pnl: 0, trades: 0 };
      grandBySymbol[sym].pnl += row.pnl;
      grandBySymbol[sym].trades += row.trades;
    }
    grandTotal += dayTotal;
  }

  const gaps = getHistoryGaps();
  if (gaps.length) {
    console.warn("\n=== HISTORY GAPS (skipped windows) ===");
    for (const g of gaps) console.warn(`[${g.symbol}] ${g.from} → ${g.to} :: ${g.reason}`);
  }

  console.log("\n=== GRAND TOTAL P&L ===");
  console.table(grandBySymbol);
  console.log(`TOTAL P&L: ${grandTotal.toFixed(2)}`);
  console.log(`\nTick style: ${(process.env.TICK_STYLE || "close").toLowerCase() === "ohlcpath" ? "ohlcPath (O→L→H→C/min)" : "close (1 tick/min)"}`);
})().catch(e => { console.error(e); process.exit(1); });
