/* eslint-disable no-console */

//
// Fyers client shims used by the state machine + P&L / Trades UI
// - Paper engine book-keeping for positions
// - getPnL() filtered to hide zero-only symbols
// - getQuotesV3() compatibility for webhookHandler (accepts string or string[])
// - Trade log via getTrades()
//

import { nowLtp } from "./dataSocket";

export function isPaper(): boolean {
  const v = (process.env.PAPERTRADE ?? "true").toString().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

type OrderTag = { tag?: string };

type Position = {
  posQty: number;
  avgPrice: number;
  realized: number;
};

type TradeLogEntry = {
  ts: number;
  sym: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  realized: number; // realized P&L contributed by this trade
};

// ---- In-memory stores (paper) ----------------------------------------------

const POS = new Map<string, Position>();

// Executed trades log (for /trades and /trades-ui)
const TRADES: TradeLogEntry[] = [];

// ---- Helpers ----------------------------------------------------------------

function ensurePos(sym: string): Position {
  let p = POS.get(sym);
  if (!p) {
    p = { posQty: 0, avgPrice: 0, realized: 0 };
    POS.set(sym, p);
  }
  return p;
}

// Record a trade into in-memory log
function recordTrade(
  sym: string,
  side: "BUY" | "SELL",
  qty: number,
  price: number,
  realizedPnL: number
) {
  if (qty <= 0) return;
  TRADES.push({
    ts: Date.now(),
    sym,
    side,
    qty,
    price,
    realized: realizedPnL,
  });
}

// ---- Public helpers used by the state machine -------------------------------

export function roundPrice(px: number): number {
  // Round to nearest 0.5 (common for options in your logic)
  return Math.round(px * 2) / 2;
}

export function getOpenQty(sym: string): number {
  return ensurePos(sym).posQty;
}

// Very simple qty logic:
// - If there is an open position, reuse its absolute size for exits (no-flip).
// - If flat, use a default lot size from env or fallback.
const DEFAULT_QTY = Number(process.env.DEFAULT_TRADE_QTY ?? process.env.QTY ?? 50);

export function computeQtyFromPnLContext(sym: string): number {
  const open = Math.abs(getOpenQty(sym));
  if (open > 0) return open;
  return DEFAULT_QTY;
}

// ---- Paper engine: placeLimitBuy / placeLimitSell ---------------------------

export function placeLimitBuy(
  sym: string,
  qty: number,
  limitPx: number,
  info?: OrderTag
): void {
  if (qty <= 0) return;

  const p = ensurePos(sym);
  const totalCost = p.avgPrice * p.posQty + limitPx * qty;
  const newQty = p.posQty + qty;
  p.posQty = newQty;
  p.avgPrice = newQty !== 0 ? totalCost / newQty : 0;

  // BUY doesn't realize P&L by itself (opening / adding)
  recordTrade(sym, "BUY", qty, limitPx, 0);

  const t = new Date().toTimeString().slice(0, 8);
  console.log(
    `[PAPER] ${t} Placed BUY LIMIT ${qty} ${sym} @ ${limitPx} ${
      info?.tag ? `(tag=${info.tag})` : ""
    } (orderId=PPR-${Math.floor(Math.random() * 100000)})`
  );
  console.log(`[PAPER] ${t} FILLED BUY ${qty} ${sym} @ ${limitPx}`);
}

export function placeLimitSell(
  sym: string,
  qty: number,
  limitPx: number,
  info?: OrderTag
): void {
  if (qty <= 0) return;

  const p = ensurePos(sym);
  let realizedOnThisTrade = 0;

  // Close existing long first (if any)
  const closeQty = Math.min(qty, Math.max(0, p.posQty));
  if (closeQty > 0) {
    const pnl = (limitPx - p.avgPrice) * closeQty;
    p.realized += pnl;
    realizedOnThisTrade += pnl;
    p.posQty -= closeQty;
    if (p.posQty === 0) p.avgPrice = 0;
  }

  // Remaining quantity becomes new short (if any)
  const remaining = qty - closeQty;
  if (remaining > 0) {
    const totalCost = p.avgPrice * p.posQty - limitPx * remaining;
    const newQty = p.posQty - remaining;
    p.posQty = newQty;
    p.avgPrice = newQty !== 0 ? totalCost / newQty : 0;
  }

  // Log SELL trade with realized P&L from the closed portion
  recordTrade(sym, "SELL", qty, limitPx, realizedOnThisTrade);

  const t = new Date().toTimeString().slice(0, 8);
  console.log(
    `[PAPER] ${t} Placed SELL LIMIT ${qty} ${sym} @ ${limitPx} ${
      info?.tag ? `(tag=${info.tag})` : ""
    } (orderId=PPR-${Math.floor(Math.random() * 100000)})`
  );
  console.log(`[PAPER] ${t} FILLED SELL ${qty} ${sym} @ ${limitPx}`);
}

// ---- Quotes shim for webhookHandler ----------------------------------------
//
// webhookHandler calls:
//   const q = await getQuotesV3(symbol);
//   const qSym = q[symbol];
//   if (qSym && Number(qSym.ltp) > 0) return qSym.ltp;
//

export async function getQuotesV3(
  symbolOrSymbols: string | string[]
): Promise<Record<string, { ltp: number }>> {
  const symbols = Array.isArray(symbolOrSymbols)
    ? symbolOrSymbols
    : [symbolOrSymbols];

  const out: Record<string, { ltp: number }> = {};

  for (const sym of symbols) {
    const fromTick = nowLtp(sym);
    const p = POS.get(sym);

    // Prefer real-time tick if present, else use avgPrice as a rough proxy
    const ltp =
      fromTick != null
        ? fromTick
        : p && p.posQty !== 0
        ? p.avgPrice
        : 0;

    out[sym] = { ltp };
  }

  return out;
}

// ---- P&L for UI -------------------------------------------------------------

export function getPnL() {
  let realized = 0;
  let unrealized = 0;

  const bySymbol: Record<
    string,
    {
      posQty: number;
      avgPrice: number;
      last: number;
      realized: number;
      unrealized: number;
    }
  > = {};

  for (const [sym, p] of POS.entries()) {
    if (!p) continue;

    const last =
      nowLtp(sym) ??
      (p.posQty !== 0 ? p.avgPrice : 0); // fallback if no tick and flat

    const u = p.posQty !== 0 ? (last - p.avgPrice) * p.posQty : 0;

    realized += p.realized;
    unrealized += u;

    // Only show symbols that have something non-trivial
    if (p.posQty === 0 && p.realized === 0 && u === 0) continue;

    bySymbol[sym] = {
      posQty: p.posQty,
      avgPrice: p.avgPrice || 0,
      last,
      realized: p.realized,
      unrealized: u,
    };
  }

  return {
    realized,
    unrealized,
    total: realized + unrealized,
    bySymbol,
  };
}

// ---- Trades for UI ----------------------------------------------------------

export function getTrades(): TradeLogEntry[] {
  // Return a shallow copy so callers can't mutate internal state
  return [...TRADES];
}
