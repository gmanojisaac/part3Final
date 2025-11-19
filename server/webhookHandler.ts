/* eslint-disable no-console */

import { handleBuySignal, handleSellSignal } from "./stateMachine";
import { getQuotesV3, isPaper } from "./fyersClient";
import { isMarketOpen, marketClock } from "./marketHours";
import { ensureSubscribed, onSymbolTick, nowLtp } from "./dataSocket";

/**
 * Map TradingView-style symbol → Fyers symbol.
 *
 * NIFTY is coded differently from BANKNIFTY / SENSEX.
 *
 * Examples (TV-style input):
 *   NIFTY251125C25900       → NSE:NIFTY25NOV25900CE
 *   BANKNIFTY251120P48000   → NSE:BANKNIFTY25N2048000PE
 *   SENSEX251125C75000      → NSE:SENSEX25N2575000CE
 */
function mapToFyersSymbol(human: string): string {
  // Handle NIFTY / BANKNIFTY / SENSEX in TradingView-style:
  // ROOT + YY + MM + DD + C/P + STRIKE
  const m =
    /^(NIFTY|BANKNIFTY|SENSEX)(\d{2})(\d{2})(\d{2})([CP])(\d+)$/.exec(human);

  // Fallback: if it's not in that format, assume it's already a Fyers symbol
  if (!m) {
    return human.startsWith("NSE:") ? human : `NSE:${human}`;
  }

  const [, root, yy, mm, dd, cp, strike] = m;
  const cepe = cp === "C" ? "CE" : "PE";

  // -----------------------
  // NIFTY: 3-letter month, no day
  // -----------------------
  if (root === "NIFTY") {
    const MONTH_3L: Record<string, string> = {
      "01": "JAN",
      "02": "FEB",
      "03": "MAR",
      "04": "APR",
      "05": "MAY",
      "06": "JUN",
      "07": "JUL",
      "08": "AUG",
      "09": "SEP",
      "10": "OCT",
      "11": "NOV",
      "12": "DEC",
    };

    const mon3 = MONTH_3L[mm];
    if (!mon3) {
      throw new Error(`mapToFyersSymbol: unknown month "${mm}" in "${human}"`);
    }

    // Example:
    //   NIFTY251125C25900 → NSE:NIFTY25NOV25900CE
    return `NSE:${root}${yy}${mon3}${strike}${cepe}`;
  }

  // -----------------------
  // BANKNIFTY / SENSEX: letter + day (old coding)
  // -----------------------
  const MONTH_LETTER: Record<string, string> = {
    "01": "A", // Jan
    "02": "F", // Feb
    "03": "M", // Mar
    "04": "A", // Apr
    "05": "M", // May
    "06": "J", // Jun
    "07": "J", // Jul
    "08": "A", // Aug
    "09": "S", // Sep
    "10": "O", // Oct
    "11": "N", // Nov
    "12": "D", // Dec
  };

  const monLetter = MONTH_LETTER[mm];
  if (!monLetter) {
    throw new Error(`mapToFyersSymbol: unknown month "${mm}" in "${human}"`);
  }

  // Example:
  //   BANKNIFTY251120P48000 → NSE:BANKNIFTY25N2048000PE
  //   SENSEX251125C75000    → NSE:SENSEX25N2575000CE
  const expiryCode = `${yy}${monLetter}${dd}`;
  return `NSE:${root}${expiryCode}${strike}${cepe}`;
}

function parseWebhook(text: string): {
  side: "BUY" | "SELL";
  stopPx?: number;
  symbol?: string;
  raw: string;
} {
  const raw = text;

  // Heuristic: if it mentions "side=SELL" or "Exit" → SELL, else BUY
  const side: "BUY" | "SELL" = /side=SELL|Exit/i.test(text) ? "SELL" : "BUY";

  const stopMatch = /stopPx\s*=\s*([0-9.]+)/i.exec(text);
  const symMatch =
    /sym\s*=\s*([A-Z0-9:._-]+)/i.exec(text) ||
    /symbol\s*=\s*([A-Z0-9:._-]+)/i.exec(text);

  return {
    side,
    stopPx: stopMatch ? Number(stopMatch[1]) : undefined,
    symbol: symMatch ? symMatch[1] : undefined,
    raw,
  };
}

/**
 * Try to get an LTP for `symbol` quickly:
 * 1) Use in-memory last tick (nowLtp)
 * 2) Use cached quote (getQuotesV3)
 * 3) Subscribe and wait for first tick (up to timeoutMs)
 * 4) If still nothing, return `fallbackPx` (if provided) or throw
 */
async function getLtpWithFallback(
  symbol: string,
  opts: { timeoutMs?: number; fallbackPx?: number } = {}
): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 3000;

  // 1) quick cache
  const cached = nowLtp(symbol);
  if (cached != null) return cached;

  // 2) server-side quote cache
  const q = await getQuotesV3(symbol);
  const qSym = q[symbol];
  if (qSym && Number(qSym.ltp) > 0) return qSym.ltp;

  // 3) live subscribe + wait for first tick
  await ensureSubscribed(symbol);

  const ltpFromTick = await new Promise<number | null>((resolve) => {
    let done = false;

    const off = onSymbolTick(symbol, (ltp) => {
      if (done) return;
      done = true;
      off();
      resolve(ltp);
    });

    setTimeout(() => {
      if (done) return;
      done = true;
      off();
      resolve(null);
    }, timeoutMs);
  });

  if (ltpFromTick != null) return ltpFromTick;

  // 4) fallback
  if (opts.fallbackPx != null) {
    console.warn(
      `[webhookHandler] No live LTP for ${symbol} within ${timeoutMs}ms, using fallbackPx=${opts.fallbackPx}`
    );
    return opts.fallbackPx;
  }

  // no fallback → throw
  throw new Error(
    `LTP not found for ${symbol} within ${timeoutMs}ms (waiting for live tick).`
  );
}

/**
 * Main entry from server/index.ts
 * Accepts the webhook text/body, parses it, resolves symbol & price,
 * and forwards a BUY/SELL signal into the per-symbol state machine.
 */
export async function handleWebhookText(text: string) {
  console.log("[webhookHandler] Received:", text);

  const parsed = parseWebhook(text);
  if (!parsed.symbol) {
    throw new Error("Webhook missing symbol.");
  }

  const fyersSymbol = mapToFyersSymbol(parsed.symbol);
  console.log(
    `[webhookHandler] side=${parsed.side}, symbol=${parsed.symbol} → ${fyersSymbol}`
  );

  // Get a reasonable LTP (won’t throw if we have a fallback stopPx)
  const ltp = await getLtpWithFallback(fyersSymbol, {
    timeoutMs: 3000,
    fallbackPx: parsed.stopPx, // use stopPx if no tick arrives in time
  });

  // Route signal into shared per-symbol state machine
  if (parsed.side === "BUY") {
    await handleBuySignal(fyersSymbol, ltp, parsed.raw);
  } else {
    await handleSellSignal(fyersSymbol, ltp, "EXIT_ONLY", parsed.raw);
  }
}

// Optional: expose a tiny status helper if your server wants it
export function webhookStatus() {
  const clock = marketClock();
  return {
    paper: isPaper(),
    marketOpen: isMarketOpen(),
    nowOpen: clock.isMarketOpenNow(),
  };
}
