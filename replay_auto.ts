// ============================================
// replay_auto.ts — run with:  npx ts-node replay_auto.ts ./TradingView_Alerts.csv
// ============================================
import fs from "node:fs";
import path from "node:path";
import { fetchHistoryCandles, candlesToTicks, getHistoryGaps } from "./fyersHistory"; // add getHistoryGaps
import { runSimulation } from "./simulator";
import type { Tick } from "./types";
import type { Candle } from "./fyersHistory";

// parse TradingView CSV (headers: Alert ID,Ticker,Name,Description,Time)
type Row = { time: Date; symbol: string; signal: "BUY" | "SELL" };

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

    // BUY/SELL detection
    const isBuy = /accepted\s*entry/i.test(desc) || /buy\s*signal/i.test(desc);
    const isSell = /accepted\s*exit/i.test(desc)  || /sell\s*signal/i.test(desc);
    const side = isBuy ? "BUY" : isSell ? "SELL" : null;
    if (!side) continue;

    // symbol: prefer sym=... in Description, else take Ticker before the comma
    let symbol = "";
    const m = desc.match(/sym\s*=\s*([^\s|,]+)/i) || desc.match(/sym\s*:\s*([^\s|,]+)/i);
    if (m) {
      symbol = m[1];
      // If symbol lacks exchange prefix but ticker has it, use ticker's prefix
      if (!/^[A-Z]+:/.test(symbol) && ticker.includes(":")) {
        const exchange = ticker.split(":")[0];
        symbol = `${exchange}:${symbol}`;
      }
    } else if (ticker) {
      symbol = ticker.split(",")[0].trim(); // "NSE:NIFTY..., 1m" → "NSE:NIFTY..."
    }

    if (!symbol) continue;

    out.push({ time: new Date(timeStr), symbol, signal: side });
  }

  return out.sort((a, b) => a.time.getTime() - b.time.getTime());
}

// splits a single CSV line respecting quotes
function splitCSVLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // toggle unless it's an escaped quote
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: ts-node replay_auto.ts <TradingView_Alerts.csv>");
    process.exit(1);
  }
  const abs = path.resolve(process.cwd(), file);
  const signals = parseTradingViewCSV(abs);
  if (!signals.length) throw new Error("No signals found in CSV");

  // auto-detect date & symbol from first signal
  const primarySymbol = signals[0].symbol;
  const dateISO = signals[0].time.toISOString().slice(0, 10);
  console.log(`Detected symbol=${primarySymbol}  date=${dateISO}  signals=${signals.length}`);

  // Trading session (IST): tweak if your window differs
  const from = new Date(`${dateISO}T03:30:00Z`); // ~09:00 IST
  const to   = new Date(`${dateISO}T10:30:00Z`); // ~16:00 IST

  // fetch history and convert to ticks (use ohlcPath for better SL realism)
  let candles: Candle[] = [];
  try {
    
const candles = await fetchHistoryCandles(primarySymbol, from, to, {
  sliceMins: 20,          // start smaller; you can try 10 if needed
  maxRetries: 5,          // retries per URL candidate
  maxAttemptsPerSlice: 6, // how many times we halve (30→15→7→3→1)
  baseWaitMs: 1200,
  jitterMs: 600,
  pauseBetweenSlicesMs: 250,
  allowSkipFinal: true,   // still run even if a tiny subwindow fails
});

const histTicks: Tick[] = candlesToTicks(primarySymbol, candles, "ohlcPath");

// (after simulation)
const gaps = getHistoryGaps();
if (gaps.length) {
  console.warn("\n=== HISTORY GAPS (skipped windows) ===");
  for (const g of gaps) console.warn(`${g.from} → ${g.to} :: ${g.reason}`);
}
  } catch (err) {
    console.error("Failed to fetch history from FYERS:", err);
    // fallback: try to load cached candles if available
    const cacheFile = path.resolve(
      process.cwd(),
      `${primarySymbol.replace(/[:\/]/g, "_")}_${dateISO}.candles.json`
    );
    if (fs.existsSync(cacheFile)) {
      console.warn("Loading candles from cache:", cacheFile);
      try {
        const raw = fs.readFileSync(cacheFile, "utf8");
        candles = JSON.parse(raw) as Candle[];
      } catch (e) {
        console.error("Failed to parse cache file:", e);
        throw err;
      }
    } else {
      throw err;
    }
  }

  const histTicks: Tick[] = candlesToTicks(primarySymbol, candles, "ohlcPath");

  // merge signals into ticks (inline to avoid extra imports)
  const merged: Tick[] = mergeTicksAndSignals(histTicks, signals);

  // simulate
  const result = runSimulation(merged, { qty: 50, cooldownSecs: 60 });
  console.log("\n=== SUMMARY ===");
  console.table(result.bySymbol);
  console.log(`TOTAL P&L: ${result.totalPnl.toFixed(2)}`);
}

// lightweight merger (same behavior as signals.ts)
function mergeTicksAndSignals(
  historyTicks: Tick[],
  signals: { time: Date; symbol: string; signal: "BUY" | "SELL" }[]
): Tick[] {
  const key = (s: string, d: Date) => `${s}|${d.toISOString()}`;
  const sigMap = new Map<string, ("BUY" | "SELL")[]>();
  for (const s of signals) {
    const k = key(s.symbol, s.time);
    (sigMap.get(k) ?? sigMap.set(k, []).get(k)!).push(s.signal);
  }
  const out: Tick[] = [];
  for (const t of historyTicks) {
    const arr = sigMap.get(key(t.symbol, t.time));
    if (arr && arr.length) for (const s of arr) out.push({ ...t, signal: s });
    else out.push(t);
  }
  return out;
}


if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

