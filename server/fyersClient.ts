/* server/fyersClient.ts
 * Paper-trade order engine + live LTP cache facade.
 * - Stores ticks from data socket (onTickFromMarket)
 * - Serves quotes in FYERS-like shape (getQuotesV3)
 * - Simulated limit orders (place/cancel/status) when PAPERTRADE=true
 * - Tracks positions & PnL (getPnL), exposes getOpenQty() for no-flip exits
 */

type OrderSide = "BUY" | "SELL";
type OrderStatus = "PENDING" | "FILLED" | "CANCELLED";

export function isPaper(): boolean {
  return (process.env.PAPERTRADE || "").toLowerCase() === "true";
}

/* ------------------------- LTP CACHE ------------------------- */

type LastTick = { ltp: number; ts: number };
const LAST_TICK: Map<string, LastTick> = new Map();

/** Called by dataSocket when a new market tick arrives */
export function onTickFromMarket(symbol: string, ltp: number, ts?: number) {
  const when = typeof ts === "number" ? ts : Date.now();
  LAST_TICK.set(symbol, { ltp: Number(ltp), ts: when });

  // Try filling any pending paper orders on this symbol
  if (isPaper()) tryFillPending(symbol, Number(ltp));
}

/** Quote facade used by webhook/stateMachine. Accepts string or string[] */
export async function getQuotesV3(symbol: string | string[]) {
  const syms = Array.isArray(symbol) ? symbol : [symbol];
  const d = syms.map((s) => {
    const tk = LAST_TICK.get(s);
    return {
      s,
      v: {
        lp: tk?.ltp ?? null,
        tt: tk?.ts ?? null, // epoch ms
      },
    };
  });
  return { d };
}

/* ------------------------- PAPER ENGINE ------------------------- */

type PlaceOrderReq = {
  symbol: string;
  side: OrderSide;
  qty: number;
  limitPrice: number;
  /** sent only in live mode (ignored in paper) */
  productType?: string;
};

type PlaceOrderResp = { id: string };

type PaperOrder = {
  id: string;
  symbol: string;
  side: OrderSide;
  qty: number;
  limitPrice: number;
  status: OrderStatus;
  createdAt: number;
  filledAt?: number;
  cancelledAt?: number;
};

const ORDERS = new Map<string, PaperOrder>();
let orderSeq = 1;

/** Positions & PnL */
type Pos = {
  posQty: number;        // +ve long, -ve short
  avgPrice: number;      // average entry price for open qty
  realized: number;      // realized P&L
};
const POS = new Map<string, Pos>();

function getOrInitPos(sym: string): Pos {
  let p = POS.get(sym);
  if (!p) {
    p = { posQty: 0, avgPrice: 0, realized: 0 };
    POS.set(sym, p);
  }
  return p;
}

/** Return current open qty for a symbol (long +, short -). */
export function getOpenQty(symbol: string): number {
  return POS.get(symbol)?.posQty ?? 0;
}

/** Optional: full position snapshot */
export function getPosition(symbol: string): { posQty: number; avgPrice: number; realized: number } {
  const p = POS.get(symbol) || { posQty: 0, avgPrice: 0, realized: 0 };
  return { posQty: p.posQty, avgPrice: p.avgPrice, realized: p.realized };
}

export function getPnL() {
  let realized = 0;
  let unrealized = 0;
  const bySymbol: Record<
    string,
    { posQty: number; avgPrice: number; last: number; realized: number; unrealized: number }
  > = {};

  for (const [sym, p] of POS.entries()) {
    realized += p.realized;
    const last = LAST_TICK.get(sym)?.ltp ?? 0;
    const u = (last - p.avgPrice) * p.posQty; // works for +/-
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

/** Helper: determine if a pending limit order should fill at given LTP */
function shouldFill(o: PaperOrder, ltp: number): boolean {
  if (o.side === "BUY") return ltp <= o.limitPrice;
  return ltp >= o.limitPrice;
}

/** Try to fill all pending orders for a symbol at the given LTP */
function tryFillPending(symbol: string, ltp: number) {
  for (const o of ORDERS.values()) {
    if (o.symbol !== symbol) continue;
    if (o.status !== "PENDING") continue;
    if (!shouldFill(o, ltp)) continue;

    // Fill it
    o.status = "FILLED";
    o.filledAt = Date.now();

    // Update positions & realized P&L
    const pos = getOrInitPos(symbol);
    if (o.side === "BUY") {
      // New qty and new ave price for long add OR reduce short
      const newQty = pos.posQty + o.qty;
      if (pos.posQty >= 0) {
        // increasing/creating long: adjust avg
        pos.avgPrice = (pos.avgPrice * pos.posQty + o.limitPrice * o.qty) / (newQty || 1);
        pos.posQty = newQty;
      } else {
        // covering short
        const coverQty = Math.min(o.qty, -pos.posQty);
        // realized: (entry short avg - buy price) * coverQty
        pos.realized += (pos.avgPrice - o.limitPrice) * coverQty;
        pos.posQty += coverQty;
        const remainder = o.qty - coverQty;
        if (remainder > 0) {
          // flip to net long
          pos.avgPrice = o.limitPrice;
          pos.posQty += remainder;
        } else {
          if (pos.posQty === 0) pos.avgPrice = o.limitPrice;
        }
      }
    } else {
      // SELL
      const newQty = pos.posQty - o.qty;
      if (pos.posQty <= 0) {
        // increasing/creating short
        pos.avgPrice = (pos.avgPrice * (-pos.posQty) + o.limitPrice * o.qty) / ((-newQty) || 1);
        pos.posQty = newQty;
      } else {
        // selling from a long
        const exitQty = Math.min(o.qty, pos.posQty);
        // realized: (sell price - long avg) * exitQty
        pos.realized += (o.limitPrice - pos.avgPrice) * exitQty;
        pos.posQty -= exitQty;
        const remainder = o.qty - exitQty;
        if (remainder > 0) {
          // flip to net short
          pos.avgPrice = o.limitPrice;
          pos.posQty -= remainder;
        } else {
          if (pos.posQty === 0) pos.avgPrice = o.limitPrice;
        }
      }
    }

    console.log(
      `[PAPER] ${tsStr()} FILLED ${o.side} ${o.qty} ${symbol} @ ${o.limitPrice} (orderId=${o.id})`
    );
  }
}

/** Place a limit order (paper); in live this is where you'd call REST v3 */
export async function placeLimitOrderV3(req: PlaceOrderReq): Promise<PlaceOrderResp> {
  if (!isPaper()) {
    // live implementation placeholder: call FYERS REST v3 here
    throw new Error("placeLimitOrderV3: live orders not implemented in this build");
  }

  const id = `PPR-${orderSeq++}`;
  const o: PaperOrder = {
    id,
    symbol: req.symbol,
    side: req.side,
    qty: Math.max(1, Math.floor(req.qty)),
    limitPrice: Number(req.limitPrice),
    status: "PENDING",
    createdAt: Date.now(),
  };
  ORDERS.set(id, o);

  console.log(
    `[PAPER] ${tsStr()} Placed ${req.side} LIMIT ${o.qty} ${req.symbol} @ ${o.limitPrice} (orderId=${id})`
  );

  // If current LTP crosses, fill immediately
  const l = LAST_TICK.get(req.symbol)?.ltp;
  if (l != null) tryFillPending(req.symbol, l);

  return { id };
}

/** Cancel a paper order */
export async function cancelOrderV3(orderId: string): Promise<{ ok: boolean }> {
  if (!isPaper()) throw new Error("cancelOrderV3: live orders not implemented in this build");
  const o = ORDERS.get(orderId);
  if (!o || o.status !== "PENDING") return { ok: false };
  o.status = "CANCELLED";
  o.cancelledAt = Date.now();
  console.log(`[PAPER] ${tsStr()} Cancelled order ${orderId}`);
  return { ok: true };
}

/** Get order status (FYERS-like) */
export async function getOrderStatusV3(orderId: string): Promise<{ found: boolean; status: OrderStatus }> {
  const o = ORDERS.get(orderId);
  if (!o) return { found: false, status: "PENDING" };
  return { found: true, status: o.status };
}

export function isOrderPending(st: OrderStatus): boolean {
  return st === "PENDING";
}

/* ------------------------- UTIL ------------------------- */

function tsStr(d = new Date()) {
  const p = (n: number, w = 2) => n.toString().padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
