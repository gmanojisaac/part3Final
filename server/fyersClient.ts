/* eslint-disable no-console */

//
// Fyers client shims used by the state machine + P&L UI
// - Paper engine book-keeping for positions
// - getPnL() filtered to hide zero-only symbols
// - getQuotesV3() compatibility for webhookHandler (accepts string or string[])
//

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

type Tick = {
  ltp: number;
  ts: number;
};

// ---- In-memory stores (paper) ----------------------------------------------

const POS = new Map<string, Position>();
const LAST_TICK = new Map<string, Tick>();

export function __paper_onTick(sym: string, ltp: number) {
  LAST_TICK.set(sym, { ltp, ts: Date.now() });
}

// ---- Helpers ----------------------------------------------------------------

export function roundPrice(px: number, step = 0.05) {
  const inv = 1 / step;
  return Math.round(px * inv) / inv;
}

export function getOpenQty(sym: string): number {
  const p = POS.get(sym);
  return p?.posQty ?? 0;
}

function ensurePos(sym: string): Position {
  if (!POS.has(sym)) POS.set(sym, { posQty: 0, avgPrice: 0, realized: 0 });
  return POS.get(sym)!;
}

// Basic sizing hook (wire your real risk logic here)
export function computeQtyFromPnLContext(sym: string): number {
  void sym;
  return 18;
}

// ---- Order emulation (paper) ------------------------------------------------

export function placeLimitBuy(sym: string, qty: number, limitPx: number, info?: OrderTag) {
  if (qty <= 0) return;
  const p = ensurePos(sym);
  const totalCost = p.avgPrice * p.posQty + limitPx * qty;
  const newQty = p.posQty + qty;
  p.posQty = newQty;
  p.avgPrice = newQty !== 0 ? totalCost / newQty : 0;

  const t = new Date().toTimeString().slice(0, 8);
  console.log(
    `[PAPER] ${t} Placed BUY LIMIT ${qty} ${sym} @ ${limitPx} ${
      info?.tag ? `(tag=${info.tag})` : ""
    } (orderId=PPR-${Math.floor(Math.random() * 1000)})`
  );
  console.log(`[PAPER] ${t} FILLED BUY ${qty} ${sym} @ ${limitPx}`);
}

export function placeLimitSell(sym: string, qty: number, limitPx: number, info?: OrderTag) {
  if (qty <= 0) return;
  const p = ensurePos(sym);

  const closeQty = Math.min(qty, Math.max(0, p.posQty));
  if (closeQty > 0) {
    const pnl = (limitPx - p.avgPrice) * closeQty;
    p.realized += pnl;
    p.posQty -= closeQty;
    if (p.posQty === 0) p.avgPrice = 0;
  }

  const remaining = qty - closeQty;
  if (remaining > 0) {
    const totalCost = p.avgPrice * p.posQty - limitPx * remaining;
    const newQty = p.posQty - remaining;
    p.posQty = newQty;
    p.avgPrice = newQty !== 0 ? totalCost / newQty : 0;
  }

  const t = new Date().toTimeString().slice(0, 8);
  console.log(
    `[PAPER] ${t} Placed SELL LIMIT ${qty} ${sym} @ ${limitPx} ${
      info?.tag ? `(tag=${info.tag})` : ""
    } (orderId=PPR-${Math.floor(Math.random() * 1000)})`
  );
  console.log(`[PAPER] ${t} FILLED SELL ${qty} ${sym} @ ${limitPx}`);
}

// ---- Quotes (compat for webhookHandler) -------------------------------------

/**
 * getQuotesV3(symbolOrList)
 * - Accepts a single `string` or `string[]`
 * - Returns a record: { [symbol]: { ltp, ts } }
 */
export async function getQuotesV3(
  symbols: string | string[]
): Promise<Record<string, { ltp: number; ts: number }>> {
  const arr = Array.isArray(symbols) ? symbols : [symbols];
  const out: Record<string, { ltp: number; ts: number }> = {};
  const now = Date.now();
  for (const s of arr) {
    const t = LAST_TICK.get(s);
    if (t) out[s] = { ltp: t.ltp, ts: t.ts };
    else out[s] = { ltp: 0, ts: now };
  }
  return out;
}

// ---- P&L for UI -------------------------------------------------------------

export function getPnL() {
  let realized = 0;
  let unrealized = 0;

  const bySymbol: Record<
    string,
    { posQty: number; avgPrice: number; last: number; realized: number; unrealized: number }
  > = {};

  const EPS = 1e-6;

  for (const [sym, p] of POS.entries()) {
    const last = LAST_TICK.get(sym)?.ltp ?? 0;
    const u = (last - (p.avgPrice || 0)) * p.posQty;

    const include =
      Math.abs(p.posQty) > 0 || Math.abs(p.realized) > EPS || Math.abs(u) > EPS;

    if (!include) continue;

    realized += p.realized;
    unrealized += u;

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
