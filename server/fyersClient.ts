// server/fyersClient.ts
import { roundToTick, nowIST } from "./helpers";

/** Papertrade flag */
const IS_PAPER = (process.env.PAPERTRADE || "").toLowerCase() === "true";

/** --- Shared types (align with stateMachine usage) --- */
export type OrderSide = "BUY" | "SELL";
export type OrderStatus = "PENDING" | "FILLED" | "CANCELLED";

export interface PlaceOrderResp {
  orderId: string;   // native id we generate/receive
  id: string;        // alias for compatibility (stateMachine reads .id)
}

export interface OrderInfo {
  orderId: string;
  symbol: string;
  side: OrderSide;
  qty: number;           // absolute lot qty
  limitPrice: number;    // rounded to tick
  status: OrderStatus;
  filledPrice?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Position {
  symbol: string;
  qty: number;           // + long, - short
  avgPrice: number;      // average price for current open qty
}

export interface PnLReport {
  realized: number;
  unrealized: number;
  total: number;
  bySymbol: Record<
    string,
    {
      realized: number;
      unrealized: number;
      posQty: number;
      avgPrice: number;
      last: number | null;
    }
  >;
}

/** -----------------------------------------------------------------------
 * Quote cache (used by getQuotesV3 in both paper & live)
 * ----------------------------------------------------------------------*/
const quoteCache = new Map<string, { ltp: number; ts: number }>();

/* ============================================================================
 * Paper broker (in-memory)
 * ==========================================================================*/
class PaperBroker {
  private seq = 1;
  private orders = new Map<string, OrderInfo>();
  private positions = new Map<string, Position>();
  private realizedBySymbol = new Map<string, number>();

  /** Place a LIMIT order */
  private _placeLimit(symbol: string, side: OrderSide, qty: number, limitPrice: number): PlaceOrderResp {
    const orderId = `PPR-${this.seq++}`;
    const lp = roundToTick(limitPrice);
    const now = Date.now();
    const order: OrderInfo = {
      orderId,
      symbol,
      side,
      qty: Math.max(1, Math.floor(qty)),
      limitPrice: lp,
      status: "PENDING",
      createdAt: now,
      updatedAt: now
    };
    this.orders.set(orderId, order);
    console.log(`[PAPER] ${nowIST()} Placed ${side} LIMIT ${order.qty} ${symbol} @ ${lp} (orderId=${orderId})`);
    // return with both fields for compatibility
    return { orderId, id: orderId };
  }

  private _cancelOrder(orderId: string) {
    const o = this.orders.get(orderId);
    if (!o) return;
    if (o.status === "PENDING") {
      o.status = "CANCELLED";
      o.updatedAt = Date.now();
      console.log(`[PAPER] ${nowIST()} Cancelled order ${orderId}`);
    }
  }

  private addRealized(symbol: string, amt: number) {
    const cur = this.realizedBySymbol.get(symbol) ?? 0;
    this.realizedBySymbol.set(symbol, cur + amt);
  }

  /** Tick from market feed */
  onTick(symbol: string, ltp: number) {
    // update module-level quote cache
    quoteCache.set(symbol, { ltp, ts: Date.now() });

    // Fill pending orders if crossed
    for (const o of this.orders.values()) {
      if (o.symbol !== symbol) continue;
      if (o.status !== "PENDING") continue;

      // LIMIT cross logic: BUY fills if ltp <= limit; SELL fills if ltp >= limit
      if ((o.side === "BUY" && ltp <= o.limitPrice) || (o.side === "SELL" && ltp >= o.limitPrice)) {
        o.status = "FILLED";
        o.filledPrice = o.limitPrice;
        o.updatedAt = Date.now();
        this.applyFill(o);
        console.log(`[PAPER] ${nowIST()} FILLED ${o.side} ${o.qty} ${symbol} @ ${o.filledPrice} (orderId=${o.orderId})`);
      }
    }
  }

  /** Apply fill to position inventory and realize P&L if closing/crossing */
  private applyFill(o: OrderInfo) {
    const px = o.filledPrice ?? o.limitPrice;
    const sign = o.side === "BUY" ? +1 : -1;
    const prior = this.positions.get(o.symbol) || { symbol: o.symbol, qty: 0, avgPrice: 0 };
    const newQty = prior.qty + sign * o.qty;

    // If prior and order are opposite signs (reducing/closing), realize P&L on closed portion
    if (prior.qty !== 0 && Math.sign(prior.qty) !== Math.sign(sign)) {
      const closingQty = Math.min(Math.abs(prior.qty), o.qty);
      const realized =
        prior.qty > 0
          ? (px - prior.avgPrice) * closingQty // closing long with SELL
          : (prior.avgPrice - px) * closingQty; // closing short with BUY
      if (closingQty > 0) {
        this.addRealized(o.symbol, realized);
        console.log(
          `[PAPER] ${nowIST()} Realized P&L ${o.symbol}: ${realized.toFixed(2)} on ${closingQty} @ ${px} (avg ${prior.avgPrice})`
        );
      }
      // residual into opposite direction?
      const residual = o.qty - closingQty;
      if (residual > 0) {
        const residualQty = sign * residual; // new position sign
        this.positions.set(o.symbol, { symbol: o.symbol, qty: residualQty, avgPrice: px });
      } else {
        // still have some of prior open?
        const remaining = Math.sign(prior.qty) * (Math.abs(prior.qty) - closingQty);
        if (remaining !== 0) {
          this.positions.set(o.symbol, { symbol: o.symbol, qty: remaining, avgPrice: prior.avgPrice });
        } else {
          this.positions.set(o.symbol, { symbol: o.symbol, qty: 0, avgPrice: 0 });
        }
      }
      return;
    }

    // Same direction or prior flat: update weighted avg (when adding size)
    if (newQty === 0) {
      this.positions.set(o.symbol, { symbol: o.symbol, qty: 0, avgPrice: 0 });
    } else if (Math.sign(newQty) === Math.sign(prior.qty) || prior.qty === 0) {
      // weighted average price for the side we are adding to
      if (sign > 0) {
        // adding to long
        const absPrior = Math.max(prior.qty, 0);
        const cost = absPrior * prior.avgPrice + o.qty * px;
        const qty = absPrior + o.qty;
        this.positions.set(o.symbol, { symbol: o.symbol, qty: newQty, avgPrice: cost / qty });
      } else {
        // adding to short
        const absPrior = Math.abs(Math.min(prior.qty, 0));
        const cost = absPrior * prior.avgPrice + o.qty * px;
        const qty = absPrior + o.qty;
        this.positions.set(o.symbol, { symbol: o.symbol, qty: newQty, avgPrice: cost / qty });
      }
    } else {
      // safety fallback
      this.positions.set(o.symbol, { symbol: o.symbol, qty: newQty, avgPrice: prior.avgPrice });
    }
  }

  /** Snap P&L */
  pnl(): PnLReport {
    let realized = 0;
    let unrealized = 0;
    const bySymbol: PnLReport["bySymbol"] = {};
    for (const [symbol, pos] of this.positions.entries()) {
      const last = quoteCache.get(symbol)?.ltp ?? null;
      const realizedSym = this.realizedBySymbol.get(symbol) ?? 0;
      const u =
        last == null
          ? 0
          : pos.qty >= 0
          ? (last - pos.avgPrice) * pos.qty
          : (pos.avgPrice - last) * Math.abs(pos.qty);
      realized += realizedSym;
      unrealized += u;
      bySymbol[symbol] = {
        realized: realizedSym,
        unrealized: u,
        posQty: pos.qty,
        avgPrice: pos.avgPrice,
        last
      };
    }
    return { realized, unrealized, total: realized + unrealized, bySymbol };
  }

  /* -- Public API (mirrors Real client) ----------------------------------- */
  async placeLimitBuy(symbol: string, qty: number, limitPrice: number): Promise<PlaceOrderResp> {
    return this._placeLimit(symbol, "BUY", qty, limitPrice);
  }
  async placeLimitSell(symbol: string, qty: number, limitPrice: number): Promise<PlaceOrderResp> {
    return this._placeLimit(symbol, "SELL", qty, limitPrice);
  }
  async cancelOrder(orderId: string): Promise<void> {
    this._cancelOrder(orderId);
  }
  async getOrderStatus(orderId: string): Promise<OrderStatus> {
    const o = this.orders.get(orderId);
    return o?.status ?? "CANCELLED";
  }
  async getOrderInfo(orderId: string): Promise<OrderInfo | undefined> {
    return this.orders.get(orderId);
  }
  async getPositions(): Promise<Position[]> {
    return Array.from(this.positions.values());
  }
  getPnLReport(): PnLReport {
    return this.pnl();
  }
}

/* ============================================================================
 * Real FYERS client (use your existing implementation)
 *   - Keep the same method signatures so stateMachine remains unchanged
 * ==========================================================================*/
class RealFyersClient {
  async placeLimitBuy(_symbol: string, _qty: number, _limitPrice: number): Promise<PlaceOrderResp> {
    // Wire to your actual FYERS client here
    const orderId = "REAL-" + Date.now();
    return { orderId, id: orderId };
  }
  async placeLimitSell(_symbol: string, _qty: number, _limitPrice: number): Promise<PlaceOrderResp> {
    const orderId = "REAL-" + Date.now();
    return { orderId, id: orderId };
  }
  async cancelOrder(_orderId: string): Promise<void> {
    // implement for real client
  }
  async getOrderStatus(_orderId: string): Promise<OrderStatus> {
    // implement for real client
    return "PENDING";
  }
  async getOrderInfo(_orderId: string): Promise<OrderInfo | undefined> {
    return undefined;
  }
  async getPositions(): Promise<Position[]> {
    return [];
  }
  getPnLReport(): PnLReport {
    return { realized: 0, unrealized: 0, total: 0, bySymbol: {} };
  }
}

/* ============================================================================
 * Single export surface
 * ==========================================================================*/
const paper = new PaperBroker();
const real = new RealFyersClient();

/** This is what the stateMachine imports/uses */
export const fyersClient = IS_PAPER ? paper : real;

/** Feed ticks into the paper broker only in paper mode; always update quote cache */
export function onTickFromMarket(symbol: string, ltp: number) {
  // update cache for both modes
  quoteCache.set(symbol, { ltp, ts: Date.now() });
  if (IS_PAPER) paper.onTick(symbol, ltp);
}

/** Read-only helpers for routes/diagnostics */
export function isPaper(): boolean {
  return IS_PAPER;
}
export function getPnL(): PnLReport {
  return (IS_PAPER ? paper : real).getPnLReport();
}

/* -----------------------------------------------------------------------------
 * Compatibility helpers for stateMachine.ts
 * ---------------------------------------------------------------------------*/

/** Simple predicate the state machine expects */
export function isOrderPending(status: OrderStatus | undefined): boolean {
  return status === "PENDING";
}

/** Legacy wrapper expected by some stateMachine versions.
 * Returns { found, status } because stateMachine reads both.
 */
export async function getOrderStatusV3(orderId: string): Promise<{ found: boolean; status: OrderStatus }> {
  try {
    // @ts-ignore - both paper and real clients expose getOrderStatus
    if (typeof fyersClient.getOrderStatus === "function") {
      // @ts-ignore
      const status: OrderStatus = await fyersClient.getOrderStatus(orderId);
      return { found: true, status };
    }
    console.warn("[getOrderStatusV3] fyersClient.getOrderStatus missing");
    return { found: false, status: "CANCELLED" };
  } catch (e) {
    console.warn("[getOrderStatusV3] error:", e);
    return { found: false, status: "CANCELLED" };
  }
}

/**
 * Legacy quotes helper.
 * Supports both single symbol (string) and array of symbols ([string]).
 * Returns FYERS-like shape so code like q?.d?.[0]?.v?.lp works.
 */
export async function getQuotesV3(
  symbols: string | string[]
): Promise<{
  d: Array<{ v: { lp: number | null; tt: number | null } }>;
  ltp: number | null;
  ts: number | null;
}> {
  const symbol = Array.isArray(symbols) ? symbols[0] : symbols;
  const q = quoteCache.get(symbol);
  const ltp = q?.ltp ?? null;
  const ts = q?.ts ?? null;
  return {
    d: [{ v: { lp: ltp, tt: ts } }],
    ltp,
    ts,
  };
}

/** Legacy order placer: accepts extra fields like productType (ignored) */
/** Legacy order placer: accepts extra fields like productType (ignored) */
export async function placeLimitOrderV3(args: {
  symbol: string;
  side: OrderSide;
  qty: number;
  limitPrice: number;
  // accept and ignore any extra legacy fields
  [extra: string]: any;
}): Promise<PlaceOrderResp> {
  const { symbol, side, qty, limitPrice } = args;
  const px = roundToTick(limitPrice);
  // @ts-ignore - both paper and real expose these
  if (side === "BUY" && typeof fyersClient.placeLimitBuy === "function") {
    // @ts-ignore
    return fyersClient.placeLimitBuy(symbol, qty, px);
  }
  // @ts-ignore
  if (side === "SELL" && typeof fyersClient.placeLimitSell === "function") {
    // @ts-ignore
    return fyersClient.placeLimitSell(symbol, qty, px);
  }
  throw new Error("placeLimitOrderV3: underlying client missing placeLimitBuy/placeLimitSell");
}


/** Legacy cancel wrapper */
export async function cancelOrderV3(orderId: string): Promise<void> {
  // @ts-ignore
  if (typeof fyersClient.cancelOrder === "function") {
    // @ts-ignore
    return fyersClient.cancelOrder(orderId);
  }
  console.warn("[cancelOrderV3] fyersClient.cancelOrder missing");
}
