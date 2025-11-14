/* eslint-disable no-console */

import { handleBuySignal, handleSellSignal } from "./stateMachine";
import { getQuotesV3, isPaper } from "./fyersClient";
import { isMarketOpen, marketClock } from "./marketHours";
import { ensureSubscribed, onSymbolTick, nowLtp } from "./dataSocket";

/**
 * Map TradingView-style symbol → Fyers symbol.
 *
 * Example:
 *   Input : NIFTY251118C25850
 *   Output: NSE:NIFTY25N1825850CE
 */
function mapToFyersSymbol(human: string): string {
  const m = /^NIFTY(\d{2})(\d{2})(\d{2})([CP])(\d+)$/.exec(human);
  if (!m) {
    // Fallback: if it already looks like a Fyers symbol, just prefix NSE: if needed
    return human.startsWith("NSE:") ? human : `NSE:${human}`;
  }

  const [, yy, mm, dd, cp, strike] = m;

  const monthMap: Record<string, string> = {
    "01": "J",
    "02": "F",
    "03": "M",
    "04": "A",
    "05": "M",
    "06": "J",
    "07": "J",
    "08": "A",
    "09": "S",
    "10": "O",
    "11": "N",
    "12": "D",
  };

  const monCode = monthMap[mm] ?? "N"; // default N if unknown month
  const cepe = cp === "C" ? "CE" : "PE";

  // ✅ Use full 2-digit year: "25" + "N" + "18" = "25N18"
  const expiryCode = `${yy}${monCode}${dd}`;

  // Final symbol: NSE:NIFTY25N1825950PE
  return `NSE:NIFTY${expiryCode}${strike}${cepe}`;
}

// Parse the webhook body text from TradingView / your alerts.
// Example payload:
//   "Accepted Entry + priorRisePct= 0.00 | stopPx=168.50 | sym=NIFTY251118P25950"
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
  ensureSubscribed(symbol);
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
