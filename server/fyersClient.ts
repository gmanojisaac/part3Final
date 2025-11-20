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
//   - getPnL() / getTrades(): P&L + trade log for the UI
//
// Assumptions:
//   - This is SINGLE-THREADED and stateful in-memory.
//   - No persistence: restart will wipe positions.
//   - Symbol strings are exactly what webhookHandler passes to us.
//
export type Side = "BUY" | "SELL";
import { nowLtp } from "./dataSocket";

// -----------------------------------------------------------------------------
// Environment helpers
// -----------------------------------------------------------------------------

export function isPaper(): boolean {
  return process.env.PAPERTRADE !== "0" && process.env.PAPERTRADE !== "false";
}

// -----------------------------------------------------------------------------
// Price helpers
// -----------------------------------------------------------------------------

// FYERS generally uses 2-decimal pricing for index options. We *do not*
// implement tick snapping (e.g. 0.05). We simply keep 2 decimals.
export function roundPrice(x: number): number {
  return Math.round(x * 100) / 100;
}

// -----------------------------------------------------------------------------
// Quote shim (very minimal, just v3 market data-like structure)
// -----------------------------------------------------------------------------

export interface QuoteV3 {
  symbol: string;
  ltp: number | null;
  // We only include fields we actually use. Extend as needed.
}

export async function getQuotesV3(
  symbols: string | string[]
): Promise<{ s: string; d: QuoteV3[] }> {
  const list = Array.isArray(symbols) ? symbols : [symbols];

  const d: QuoteV3[] = list.map((sym) => {
    const ltp = nowLtp(sym);
    return {
      symbol: sym,
      ltp: typeof ltp === "number" ? ltp : null,
    };
  });

  return { s: "ok", d };
}


// -----------------------------------------------------------------------------
// Paper-trading engine
// -----------------------------------------------------------------------------

// Basic position tracking per symbol
interface Position {
  posQty: number; // positive = long, negative = short, 0 = flat
  avgPrice: number; // average price of the position (if posQty !== 0)
  realized: number; // gross realized P&L (BEFORE brokerage)
}

const POSITIONS = new Map<string, Position>();

// Trades log for UI
export interface TradeLogEntry {
  ts: number;           // epoch ms
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  realized: number;     // net P&L for this trade after brokerage (0 for BUY, +/- for SELL)
  brokerage: number;    // brokerage for this trade (negative cost; usually on SELL)
  tag?: string;
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

function ensurePos(sym: string): Position {
  let p = POSITIONS.get(sym);
  if (!p) {
    p = { posQty: 0, avgPrice: 0, realized: 0 };
    POSITIONS.set(sym, p);
  }
  return p;
}

let PAPER_ORDER_ID = 1;
function nextPaperOrderId(): string {
  const id = PAPER_ORDER_ID.toString().padStart(6, "0");
  PAPER_ORDER_ID += 1;
  return `PAPER-${id}`;
}

// System time formatting just for logging
function formatTime(d: Date): string {
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// Trade log
const TRADES: TradeLogEntry[] = [];

// -----------------------------------------------------------------------------
// Position updates
// -----------------------------------------------------------------------------

// Stock-like or futures-like averaging. Here we only really care about
// options, but the math is generic.
//
// BUY qty at price for a given symbol.
//   - posQty, avgPrice updated using standard weighted average when same side.
//   - If there is an opposite position, reduce that first and realize P&L.
function applyBuyToPosition(sym: string, qty: number, price: number): void {
  const p = ensurePos(sym);
  const oldQty = p.posQty;
  const oldAvg = p.avgPrice;

  if (oldQty >= 0) {
    // Either increasing or opening a long
    const newQty = oldQty + qty;
    if (newQty === 0) {
      p.posQty = 0;
      p.avgPrice = 0;
      return;
    }
    const totalCost = oldQty * oldAvg + qty * price;
    p.posQty = newQty;
    p.avgPrice = totalCost / newQty;
  } else {
    // We had a short, BUY reduces or flips it
    const closingQty = Math.min(qty, -oldQty);
    const remainingQty = oldQty + closingQty; // oldQty is negative

    // Realize P&L: short at oldAvg, covering at price
    const realizedPnl = (oldAvg - price) * closingQty;
    p.realized += realizedPnl;

    if (remainingQty === 0) {
      // Fully flat
      p.posQty = 0;
      p.avgPrice = 0;
    } else if (remainingQty < 0) {
      // Still short
      p.posQty = remainingQty;
      p.avgPrice = oldAvg;
    } else {
      // Flipped to long, with some size = remainingQty > 0
      // The part that goes beyond covering is effectively a new long entry at "price".
      p.posQty = remainingQty;
      p.avgPrice = price;
    }
  }
}

// SELL qty at price for a given symbol.
// Symmetric to applyBuyToPosition, but with signs swapped.
function applySellToPosition(
  sym: string,
  qty: number,
  price: number
): number {
  const p = ensurePos(sym);
  const oldQty = p.posQty;
  const oldAvg = p.avgPrice;

  let realizedForThisTrade = 0;

  if (oldQty <= 0) {
    // Either increasing or opening a short
    const newQty = oldQty - qty;
    if (newQty === 0) {
      p.posQty = 0;
      p.avgPrice = 0;
      return 0;
    }
    const totalProceeds = oldQty * oldAvg - qty * price;
    p.posQty = newQty;
    p.avgPrice = totalProceeds / newQty;
    return 0;
  }

  // We had a long, SELL reduces or flips it
  const closingQty = Math.min(qty, oldQty);
  const remainingQty = oldQty - closingQty;

  // Realize P&L: long at oldAvg, selling at price
  realizedForThisTrade = (price - oldAvg) * closingQty;
  p.realized += realizedForThisTrade;

  if (remainingQty === 0) {
    // Fully flat
    p.posQty = 0;
    p.avgPrice = 0;
  } else if (remainingQty > 0) {
    // Still long
    p.posQty = remainingQty;
    p.avgPrice = oldAvg;
  } else {
    // Flipped to short, with some size = remainingQty < 0
    // The part that goes beyond closing is effectively a new short at "price".
    p.posQty = remainingQty;
    p.avgPrice = price;
  }

  return realizedForThisTrade;
}

// -----------------------------------------------------------------------------
// Quantity sizing helpers (based on capital, etc.)
// -----------------------------------------------------------------------------

// We only implement a very simple sizing logic:
// - If there is an open position, reuse its absolute size for exits (no flip).
// - If flat, size based on CAPITAL, symbol lot size and current LTP.
//   CAPITAL is read from env: CAPITAL or TRADING_CAPITAL (fallback 20000).
//   NIFTY index options (not BANKNIFTY/FINNIFTY) are assumed to have lot size 75.
const CAPITAL =
  Number(process.env.CAPITAL ?? process.env.TRADING_CAPITAL ?? "20000") || 20000;

const BROKERAGE_RATE =
  Number(process.env.BROKERAGE_RATE ?? "0.002") || 0.002;

import { getLotSize } from "./lotSize";

export function getOpenQty(sym: string): number {
  const p = POSITIONS.get(sym);
  return p?.posQty ?? 0;
}

// Compute a "reasonable" quantity for an entry based on capital and LTP.
export function computeQtyFromPnLContext(
  sym: string,
  ltpOverride?: number
): number {
  // If we already have an open position, keep that size (for exits).
  const open = Math.abs(getOpenQty(sym));
  if (open > 0) return open;

  // Flat: compute fresh qty from capital and current price.
  const lotSize = getLotSize(sym);
  const ltp = typeof ltpOverride === "number" ? ltpOverride : nowLtp(sym);
  const px = typeof ltp === "number" && ltp > 0 ? ltp : 100;

  const costPerLot = px * lotSize;
  if (!Number.isFinite(costPerLot) || costPerLot <= 0) {
    return lotSize;
  }
  const lotsFloat = CAPITAL / costPerLot;
  let lots = Math.floor(lotsFloat);
  if (lots < 1) lots = 1;

  const qty = lots * lotSize;
  return qty;
}

// -----------------------------------------------------------------------------
// Paper LIMIT (instant-fill) orders
// -----------------------------------------------------------------------------

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
    console.warn(
      "[LIVE] placeLimitBuy called but live trading is not implemented in fyersClient.ts"
    );
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

  // Log trade (BUY has 0 realized P&L and 0 brokerage)
  TRADES.push({
    ts: d.getTime(),
    symbol: sym,
    side: "BUY",
    qty,
    price: limitPrice,
    realized: 0,
    brokerage: 0,
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
    console.warn(
      "[LIVE] placeLimitSell called but live trading is not implemented in fyersClient.ts"
    );
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

  const posBefore = ensurePos(sym);
  const prevQty = posBefore.posQty;
  const prevAvg = posBefore.avgPrice;

  const realizedForTrade = applySellToPosition(sym, qty, limitPrice);

  let brokerageForTrade = 0;
  if (prevQty > 0) {
    // We're closing or reducing a long
    const closingQty = Math.min(qty, prevQty);
    const deployedForTrade = prevAvg * closingQty;
    brokerageForTrade = -BROKERAGE_RATE * deployedForTrade;
  }

  const netRealizedForTrade = realizedForTrade + brokerageForTrade;

  TRADES.push({
    ts: d.getTime(),
    symbol: sym,
    side: "SELL",
    qty,
    price: limitPrice,
    realized: netRealizedForTrade,
    brokerage: brokerageForTrade,
    tag,
  });
}

// -----------------------------------------------------------------------------
// P&L computation (with brokerage)
// -----------------------------------------------------------------------------
//
// Assumptions:
//   - Position.realized is "gross realized" P&L (before brokerage).
//   - Brokerage is aggregated from per-trade TradeLogEntry.brokerage (global sum).
//   - Brokerage is returned as a negative number and reduces final P&L.
//   - unrealized is always computed from current LTP (or 0 if not available).
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

  // Brokerage: sum of per-trade brokerage from TRADES
  let brokerage = 0;
  for (const t of TRADES) {
    brokerage += t.brokerage || 0;
  }

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

    const grossSym = p.realized;

    let symBrokerage = 0;
    for (const t of TRADES) {
      if (t.symbol === sym) {
        symBrokerage += t.brokerage || 0;
      }
    }

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
  // Return a shallow copy so callers can't mutate internal state.
  return TRADES.slice();
}
