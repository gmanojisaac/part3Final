// symbolMap.ts — TV → FYERS (index options) with exchange + month variants
import { getHistory, type HistoryInput } from "./fyersClient";

async function probeHasData(symbol: string, when: Date): Promise<boolean> {
  const from = new Date(when.getTime() - 5 * 60_000);
  const to   = new Date(when.getTime() + 5 * 60_000);
  const inp: HistoryInput = {
    symbol,
    resolution: "1",
    date_format: "0",
    range_from: String(Math.floor(from.getTime() / 1000)),
    range_to:   String(Math.floor(to.getTime() / 1000)),
    cont_flag: "1",
  };
  try {
    const res = await getHistory(inp);
    const arr: any[] = res?.candles ?? res?.data ?? [];
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return false;
  }
}

// Helpers
const monthInitial: Record<number, string> = {
  1:"J",2:"F",3:"M",4:"A",5:"M",6:"J",7:"J",8:"A",9:"S",10:"O",11:"N",12:"D"
};
const seriesAL: Record<number, string> = {
  1:"A",2:"B",3:"C",4:"D",5:"E",6:"F",7:"G",8:"H",9:"I",10:"J",11:"K",12:"L"
};
const month3: Record<number, string> = {
  1:"JAN",2:"FEB",3:"MAR",4:"APR",5:"MAY",6:"JUN",7:"JUL",8:"AUG",9:"SEP",10:"OCT",11:"NOV",12:"DEC"
};

// TradingView index option → FYERS
// TV:    [EX:]NIFTY YY MM DD [C|P] Strike   e.g. NSE:NIFTY251111C25700
// FYERS: EX:NIFTY YY M/DD Strike CE|PE     e.g. NFO:NIFTY25N1125700CE  (or ...25NOV11...)
export async function tvIndexOptionToFyers(tvSymbol: string, when?: Date): Promise<string | null> {
  const [maybeEx, restRaw] = tvSymbol.includes(":") ? tvSymbol.split(":") : ["NSE", tvSymbol];
  const tvEx = (maybeEx || "NSE").toUpperCase();
  const rest = restRaw.replace(/\s+/g, "");
  const m = /^(NIFTY|BANKNIFTY)(\d{2})(\d{2})(\d{2})([CP])(\d+)$/.exec(rest);
  if (!m) return null;

  const [, base, yy, mm, dd, cp, strike] = m;
  const cepe = cp === "C" ? "CE" : "PE";
  const monthNum = Number(mm);

  // Build month representations to try
  const candidatesMonth = Array.from(new Set([
    // Your env showed NOV → 'N' working; prioritise letter + 3-letter code
    monthInitial[monthNum],     // e.g. 'N'
    month3[monthNum],           // e.g. 'NOV'
    seriesAL[monthNum],         // e.g. 'K' for Nov in A-L series
  ].filter(Boolean)));

  // Exchanges to try: NFO first (derivatives), then whatever TV had (often NSE)
  const exchanges = Array.from(new Set(["NFO", tvEx]));

  // Generate candidates
  const candidates: string[] = [];
  for (const ex of exchanges) {
    for (const mcode of candidatesMonth) {
      // Try both “letter” and “3-letter” month encodings
      // Format with day preserved (weekly expiry)
      candidates.push(`${ex}:${base}${yy}${mcode}${dd}${strike}${cepe}`);
    }
  }

  // If we weren’t given a time, just return the first candidate (NFO + letter month)
  if (!when) return candidates[0] ?? null;

  // Probe in order; return the first that yields candles
  for (const sym of candidates) {
    if (await probeHasData(sym, when)) return sym;
  }

  // Final fallbacks: stick with NFO first candidate
  return candidates[0] ?? null;
}

export function isTvIndexOption(sym: string): boolean {
  return /^(?:[A-Z]+:)?(NIFTY|BANKNIFTY)\d{6}[CP]\d+$/.test(sym);
}
