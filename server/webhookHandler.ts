/* eslint-disable no-console */

import { TradeStateMachine } from "./stateMachine";
import { getQuotesV3, isPaper } from "./fyersClient";
import { isMarketOpen, marketClock } from "./marketHours";
import { ensureSubscribed, onSymbolTick, nowLtp } from "./dataSocket";

// If you already have a richer mapper, swap this with your real one.
function mapToFyersSymbol(human: string): string {
  // Example: NIFTY251118C25850 -> NSE:NIFTY25N1825850CE
  // Keep your real implementation if you have one.
  const m = /^NIFTY(\d{2})(\d{2})(\d{2})([CP])(\d+)$/.exec(human);
  if (!m) return human.startsWith("NSE:") ? human : `NSE:${human}`;
  const [_, yy, mm, dd, cp, strike] = m;
  const monthMap: Record<string, string> = {
    "01": "J", "02": "F", "03": "M", "04": "A", "05": "M", "06": "J",
    "07": "J", "08": "A", "09": "S", "10": "O", "11": "N", "12": "D",
  };
  const monCode = monthMap[mm] ?? "N";
  const cepe = cp === "C" ? "CE" : "PE";
  return `NSE:NIFTY${yy}${monCode}${dd}${strike}${cepe}`;
}

// Parse a simple plaintext payload like the ones in your logs.
// e.g. "upCEAccepted Exit + priorRisePct= 0.00 | stopPx=168.50 | sym=NIFTY251118C25850"
function parseWebhook(text: string): {
  side: "BUY" | "SELL";
  stopPx?: number;
  symbol?: string;
  raw: string;
} {
  const raw = text;
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
      `[webhookHandler] LTP not received for ${symbol} within ${timeoutMs}ms — using fallback ${opts.fallbackPx}`
    );
    return opts.fallbackPx;
  }

  // no fallback → throw (old behavior)
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

  // Construct machine (your legacy ctor passes a config object)
  const m = new TradeStateMachine({
    symbol: fyersSymbol,
    underlying: "NIFTY", // optional if you want it
    orderValue: Number(process.env.ORDER_VALUE || 0),
    slPoints: Number(process.env.SL_POINTS || 0.5),
  });

  // Fire signal the way your legacy code expects
  if (parsed.side === "BUY") {
    await m.onSignal("BUY_SIGNAL", ltp, undefined, { source: "webhook" });
  } else {
    await m.onSignal("SELL_SIGNAL", ltp, "EXIT_ONLY", { source: "webhook" });
  }
}

// (Optional) expose a tiny status helper if your server wants it
export function webhookStatus() {
  const clock = marketClock();
  return {
    paper: isPaper(),
    marketOpen: isMarketOpen(),
    nowOpen: clock.isMarketOpenNow(),
  };
}
