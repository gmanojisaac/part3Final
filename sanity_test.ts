// sanity_test.ts — sanity-run 5 minutes around the first signal (with TV→FYERS conversion)
// Run:  npx ts-node sanity_test.ts ./TradingView_Alerts.csv
import fs from "node:fs";
import path from "node:path";
import { fetchHistoryCandles, candlesToTicks, getHistoryGaps } from "./fyersHistory";
import type { Tick } from "./types";
import { tvIndexOptionToFyers, isTvIndexOption } from "./symbolMap";

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

type SigRow = { time: Date; symbol: string; side: "BUY" | "SELL"; rawDesc: string; rawTicker: string };

function parseFirstSignal(csvFile: string): SigRow | null {
  const raw = fs.readFileSync(csvFile, "utf8");
  const lines = raw.trim().split(/\r?\n/);
  if (!lines.length) return null;
  const headers = splitCSVLine(lines[0]).map(s => s.trim());
  const iDesc = headers.findIndex(h => /desc/i.test(h));
  const iTime = headers.findIndex(h => /^time$/i.test(h));
  const iTicker = headers.findIndex(h => /^ticker$/i.test(h));
  if (iDesc < 0 || iTime < 0) throw new Error("CSV must contain Description and Time columns");

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

    // Build a TradingView-form symbol from desc/ticker
    let tvSymbol = "";
    const m = desc.match(/sym\s*[:=]\s*([^\s|,]+)/i);
    if (m) {
      tvSymbol = m[1];
      if (!/^[A-Z]+:/.test(tvSymbol) && ticker.includes(":")) {
        const ex = ticker.split(":")[0];
        tvSymbol = `${ex}:${tvSymbol}`;
      }
    } else if (ticker) {
      tvSymbol = ticker.split(",")[0].trim(); // "NSE:XYZ, 1m" -> "NSE:XYZ"
    }
    if (!tvSymbol) continue;

    return { time: new Date(timeStr), symbol: tvSymbol, side, rawDesc: desc, rawTicker: ticker };
  }
  return null;
}

function floorToMinute(d: Date): Date { const t = new Date(d); t.setSeconds(0,0); return t; }
function fmtISO(d: Date): string { return d.toISOString(); }

(async function main() {
  const csv = process.argv[2];
  if (!csv) { console.error("Usage: ts-node sanity_test.ts <TradingView_Alerts.csv>"); process.exit(1); }
  const abs = path.resolve(process.cwd(), csv);

  const sig = parseFirstSignal(abs);
  if (!sig) { console.error("No valid signals found in CSV."); process.exit(1); }

  // Convert TV symbol to FYERS if it's an index option
  let fyersSymbol = sig.symbol;
  if (isTvIndexOption(fyersSymbol)) {
    const converted = await tvIndexOptionToFyers(fyersSymbol, sig.time);
    if (converted) fyersSymbol = converted;
  }

  const start = floorToMinute(sig.time);
  const end = new Date(start.getTime() + 5 * 60_000);

  console.log("=== SANITY TEST INPUTS ===");
  console.log(`CSV:         ${abs}`);
  console.log(`TV symbol:   ${sig.symbol}`);
  console.log(`FYERS sym:   ${fyersSymbol}`);
  console.log(`Signal:      ${sig.side}`);
  console.log(`Signal time: ${fmtISO(sig.time)} (floored: ${fmtISO(start)})`);
  console.log(`Window:      ${fmtISO(start)} → ${fmtISO(end)} (5 minutes)`);
  console.log(`Desc:        ${sig.rawDesc}`);
  if (sig.rawTicker) console.log(`Ticker:      ${sig.rawTicker}`);
  console.log(`TICK_STYLE:  ${(process.env.TICK_STYLE || "close").toLowerCase() === "ohlcpath" ? "ohlcPath" : "close"}`);
  console.log("");

  console.log("=== CALL HISTORY (FYERS 1m) ===");
  console.log(`getHistory: symbol=${fyersSymbol}, resolution=1, from=${Math.floor(start.getTime()/1000)}, to=${Math.floor(end.getTime()/1000)}`);

  const candles = await fetchHistoryCandles(fyersSymbol, start, end, {
    sliceMins: 5,
    maxRetries: 5,
    maxAttemptsPerSlice: 3,
    baseWaitMs: 900,
    jitterMs: 400,
    pauseBetweenSlicesMs: 50,
    allowSkipFinal: true,
    rescueSpanMins: 30,
    verbose: true,
  });

  console.log("");
  console.log("=== CANDLES (raw within 5m window) ===");
  if (!candles.length) {
    console.warn("No candles returned for the selected 5-minute window (after rescue).");
  } else {
    for (const c of candles) {
      const ts = new Date(c.t * 1000).toISOString();
      console.log(`t=${ts}  o=${c.o} h=${c.h} l=${c.l} c=${c.c}${typeof c.v !== "undefined" ? ` v=${c.v}` : ""}`);
    }
  }

  const ticks: Tick[] = candlesToTicks(fyersSymbol, candles);

  console.log("");
  console.log("=== TICKS (derived) ===");
  if (!ticks.length) {
    console.warn("No ticks produced from candles.");
  } else {
    for (const t of ticks) console.log(`${t.time.toISOString()}  ltp=${t.ltp}`);
  }

  const gaps = getHistoryGaps();
  if (gaps.length) {
    console.warn("");
    console.warn("=== HISTORY GAPS (during this sanity window or rescue) ===");
    for (const g of gaps) console.warn(`[${g.symbol}] ${g.from} → ${g.to} :: ${g.reason}`);
  }

  console.log("");
  console.log("=== SANITY RESULT ===");
  console.log(`Candles: ${candles.length}, Ticks: ${ticks.length}. If at least one candle covers the signal minute, we’re good.`);
})().catch(e => { console.error(e); process.exit(1); });
