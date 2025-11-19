/* eslint-disable no-console */

//
// server/fyersClient.ts
// -----------------------------------------------------------------------------
// Fyers client shims used by the state machine + P&L / Trades UI.
// This is a pure in-memory paper-trading engine. All real FYERS calls are
// intentionally omitted; only the interfaces used by the rest of the server
// are implemented.
//
// Exposed features:
//   - isPaper(): read PAPERTRADE env
//   - roundPrice(): 2-decimal rounding (no 0.5 snapping)
//   - getQuotesV3(): FYERS v3-compatible quote shim for webhookHandler
//   - placeLimitBuy / placeLimitSell(): paper orders with instant fill
//   - getOpenQty(): current open quantity per symbol
//   - computeQtyFromPnLContext(): capital-based sizing for NIFTY options
//   - getPnL(): aggregated P&L + brokerage
//   - getTrades(): trade log for UI
// -----------------------------------------------------------------------------

import { nowLtp } from "./dataSocket";

export function isPaper(): boolean {
  const v = (process.env.PAPERTRADE ?? "true").toString().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type Side = "BUY" | "SELL";

interface Position {
  posQty: number;    // +ve = long, -ve = short (we mostly use long only)
  avgPrice: number;  // average entry price of the open position
  realized: number;  // cumulative realized P&L for this symbol (gross, before brokerage)
}

export interface TradeLogEntry {
  ts: number;           // epoch ms
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  realized: number;     // P&L for this trade (0 for BUY, +/- for SELL)
  tag?: string;
}

// -----------------------------------------------------------------------------
// In-memory state
// -----------------------------------------------------------------------------

const POSITIONS = new Map<string, Position>();
const TRADES: TradeLogEntry[] = [];

let paperOrderCounter = 1;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function ensurePos(sym: string): Position {
  let p = POSITIONS.get(sym);
  if (!p) {
    p = { posQty: 0, avgPrice: 0, realized: 0 };
    POSITIONS.set(sym, p);
  }
  return p;
}

function nextPaperOrderId(): string {
  const id = paperOrderCounter++;
  return `PPR-${id.toString().padStart(5, "0")}`;
}

function formatTime(d: Date): string {
  // Matches logs like "11:00:07"
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// -----------------------------------------------------------------------------
// Public helpers used by the state machine & webhook handler
// -----------------------------------------------------------------------------

export function roundPrice(px: number): number {
  // 👉 2 decimals, no snapping to 0.5
  return Math.round(px * 100) / 100;
}

export function getOpenQty(sym: string): number {
  return ensurePos(sym).posQty;
}

// Qty logic:
// -----------------------------------------------------------------------------
// - If there is an open position, reuse its absolute size for exits (no flip).
// - If flat, size based on CAPITAL, symbol lot size and current LTP.
//   CAPITAL is read from env: CAPITAL or TRADING_CAPITAL (fallback 20000).
//   NIFTY index options (not BANKNIFTY/FINNIFTY) are assumed to have lot size 75.
// -----------------------------------------------------------------------------

const DEFAULT_QTY =
  Number(process.env.DEFAULT_TRADE_QTY ?? process.env.QTY ?? "50") || 50;

const CAPITAL =
  Number(process.env.CAPITAL ?? process.env.TRADING_CAPITAL ?? "20000") || 20000;

function getLotSize(sym: string): number {
  const upper = sym.toUpperCase();

  // NIFTY index options (CE/PE) – treat as lot size 75,
  // but exclude BANKNIFTY / FINNIFTY etc.
  if (upper.includes("NIFTY") && !upper.includes("BANKNIFTY") && !upper.includes("FINNIFTY")) {
    return 75;
  }

  // Fallback: treat DEFAULT_QTY as an effective lot for everything else.
  return DEFAULT_QTY;
}

export function computeQtyFromPnLContext(sym: string, ltpOverride?: number): number {
  // If we already have an open position, keep that size (for exits).
  const open = Math.abs(getOpenQty(sym));
  if (open > 0) return open;

  // Flat: compute fresh qty from capital and current price.
  const lotSize = getLotSize(sym);

  const px =
    typeof ltpOverride === "number" && ltpOverride > 0
      ? ltpOverride
      : nowLtp(sym);

  if (typeof px !== "number" || !isFinite(px) || px <= 0) {
    // If we can't get a sensible price, fall back to default fixed quantity.
    return DEFAULT_QTY;
  }

  const costPerLot = px * lotSize;
  if (costPerLot <= 0) return DEFAULT_QTY;

  const lotsFloat = CAPITAL / costPerLot;
  let lots = Math.floor(lotsFloat);
  if (lots < 1) lots = 1; // at least 1 lot

  const qty = lots * lotSize;
  return qty;
}

// -----------------------------------------------------------------------------
// getQuotesV3 shim – minimal FYERS v3-like quote API
// -----------------------------------------------------------------------------

export async function getQuotesV3(
  symbols: string | string[]
): Promise<{ s: string; d: { symbol: string; ltp: number }[] }> {
  const arr = Array.isArray(symbols) ? symbols : [symbols];
  const d = arr.map((sym) => ({
    symbol: sym,
    ltp: nowLtp(sym) ?? NaN,
  }));

  return { s: "ok", d };
}

// -----------------------------------------------------------------------------
// Paper order placement
// -----------------------------------------------------------------------------

function applyBuyToPosition(sym: string, qty: number, price: number): void {
  const p = ensurePos(sym);

  if (p.posQty >= 0) {
    // Add to existing long (or open new long)
    const newQty = p.posQty + qty;
    const totalCost = p.avgPrice * p.posQty + price * qty;
    p.avgPrice = newQty > 0 ? totalCost / newQty : 0;
    p.posQty = newQty;
  } else {
    // Long buy against an existing short. For simplicity, treat as closing short,
    // but this scenario should normally not happen in your strategy.
    const closing = Math.min(qty, -p.posQty);
    const remaining = qty - closing;
    // Realized for closing part: entry (short) at avgPrice, exit (buy) at price.
    p.realized += (p.avgPrice - price) * closing;
    p.posQty += closing; // remember posQty is negative here

    if (remaining > 0) {
      // Open new long with the leftover
      const newQty = remaining;
      p.avgPrice = price;
      p.posQty = newQty;
    } else if (p.posQty === 0) {
      p.avgPrice = 0;
    }
  }
}

function applySellToPosition(sym: string, qty: number, price: number): number {
  const p = ensurePos(sym);
  let realizedForTrade = 0;

  if (p.posQty > 0) {
    // Closing or reducing a long
    const closing = Math.min(qty, p.posQty);
    realizedForTrade = (price - p.avgPrice) * closing;
    p.realized += realizedForTrade;
    p.posQty -= closing;

    if (p.posQty === 0) {
      p.avgPrice = 0;
    }
  } else if (p.posQty === 0) {
    // Opening a short – not expected in your strategy, but we support it.
    p.posQty = -qty;
    p.avgPrice = price;
  } else {
    // Increasing an existing short
    const newQty = p.posQty - qty; // more negative
    const totalProceeds = p.avgPrice * -p.posQty + price * qty;
    p.avgPrice = newQty !== 0 ? totalProceeds / -newQty : 0;
    p.posQty = newQty;
  }

  return realizedForTrade;
}

export async function placeLimitBuy(
  sym: string,
  qty: number,
  limitPrice: number,
  meta?: { tag?: string }
): Promise<void> {
  const tag = meta?.tag;
  const orderId = nextPaperOrderId();
  const d = new Date();
  const t = formatTime(d);

  if (!isPaper()) {
    console.warn("[LIVE] placeLimitBuy called but live trading is not implemented in fyersClient.ts");
  }

  console.log(
    `[PAPER] ${t} Placed BUY LIMIT ${qty} ${sym} @ ${limitPrice} ${
      tag ? `(tag=${tag}) ` : ""
    }(orderId=${orderId})`
  );

  // Instant full fill at the limit price
  console.log(
    `[PAPER] ${t} FILLED BUY ${qty} ${sym} @ ${limitPrice}`
  );

  applyBuyToPosition(sym, qty, limitPrice);

  // Log trade (BUY has 0 realized P&L)
  TRADES.push({
    ts: d.getTime(),
    symbol: sym,
    side: "BUY",
    qty,
    price: limitPrice,
    realized: 0,
    tag,
  });
}

export async function placeLimitSell(
  sym: string,
  qty: number,
  limitPrice: number,
  meta?: { tag?: string }
): Promise<void> {
  const tag = meta?.tag;
  const orderId = nextPaperOrderId();
  const d = new Date();
  const t = formatTime(d);

  if (!isPaper()) {
    console.warn("[LIVE] placeLimitSell called but live trading is not implemented in fyersClient.ts");
  }

  console.log(
    `[PAPER] ${t} Placed SELL LIMIT ${qty} ${sym} @ ${limitPrice} ${
      tag ? `(tag=${tag}) ` : ""
    }(orderId=${orderId})`
  );

  // Instant full fill at the limit price
  console.log(
    `[PAPER] ${t} FILLED SELL ${qty} ${sym} @ ${limitPrice}`
  );

  const realizedForTrade = applySellToPosition(sym, qty, limitPrice);

  TRADES.push({
    ts: d.getTime(),
    symbol: sym,
    side: "SELL",
    qty,
    price: limitPrice,
    realized: realizedForTrade,
    tag,
  });
}

// -----------------------------------------------------------------------------
// P&L computation (with brokerage)
// -----------------------------------------------------------------------------
//
// Assumptions:
//   - Position.realized is "gross realized" P&L (before brokerage).
//   - Brokerage is 10% of gross *positive* realized P&L (global).
//   - Brokerage is returned as a negative number and reduces final P&L.
// -----------------------------------------------------------------------------

export function getPnL(): {
  realized: number;      // net realized AFTER brokerage
  unrealized: number;
  total: number;         // net total = realized + unrealized
  brokerage: number;     // negative number (cost)
  grossRealized: number; // BEFORE brokerage
  bySymbol: Record<
    string,
    {
      realized: number;      // net realized after brokerage
      grossRealized: number; // before brokerage
      unrealized: number;
      brokerage: number;     // negative cost for this symbol
      posQty: number;
      avgPrice: number;
      ltp: number | null;
    }
  >;
} {
  let grossRealized = 0;
  let unrealized = 0;

  // First pass: aggregate grossRealized and unrealized
  for (const [sym, p] of POSITIONS.entries()) {
    const ltp = nowLtp(sym);
    const u =
      p.posQty !== 0 && typeof ltp === "number"
        ? (ltp - p.avgPrice) * p.posQty
        : 0;

    grossRealized += p.realized;
    unrealized += u;
  }

  // Brokerage: 10% of gross positive realized
  const brokerage =
    grossRealized > 0 ? -0.1 * grossRealized : 0;

  const netRealized = grossRealized + brokerage;
  const total = netRealized + unrealized;

  const bySymbol: Record<
    string,
    {
      realized: number;
      grossRealized: number;
      unrealized: number;
      brokerage: number;
      posQty: number;
      avgPrice: number;
      ltp: number | null;
    }
  > = {};

  // Second pass: symbol-level breakdown (including brokerage share)
  for (const [sym, p] of POSITIONS.entries()) {
    const ltp = nowLtp(sym);
    const u =
      p.posQty !== 0 && typeof ltp === "number"
        ? (ltp - p.avgPrice) * p.posQty
        : 0;

    // Skip fully-zero symbols to keep the UI tidy
    if (p.posQty === 0 && p.realized === 0 && u === 0) continue;

    const grossSym = p.realized;
    const symBrokerage =
      grossRealized > 0 && grossSym > 0
        ? (grossSym / grossRealized) * brokerage
        : 0;
    const netSym = grossSym + symBrokerage;

    bySymbol[sym] = {
      realized: netSym,
      grossRealized: grossSym,
      unrealized: u,
      brokerage: symBrokerage,
      posQty: p.posQty,
      avgPrice: p.avgPrice,
      ltp: typeof ltp === "number" ? ltp : null,
    };
  }

  return {
    realized: netRealized,
    unrealized,
    total,
    brokerage,
    grossRealized,
    bySymbol,
  };
}

// -----------------------------------------------------------------------------
// Trades for UI
// -----------------------------------------------------------------------------

export function getTrades(): TradeLogEntry[] {
  // Return a shallow copy so callers can't mutate internal state
  return [...TRADES];
}
