// server/fyersClient.ts
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { roundToTick, atLeastOneTick, nowIST } from "./helpers";
dotenv.config();

const { fyersModel: FyersAPI } = require("fyers-api-v3");

// Ensure logs dir exists
const logPath = path.resolve(__dirname, "../fyers_logs");
if (!fs.existsSync(logPath)) fs.mkdirSync(logPath, { recursive: true });

// Single SDK instance
export const fyers = new FyersAPI({ path: logPath });
fyers.setAppId(process.env.FYERS_APP_ID);
fyers.setRedirectUrl(process.env.FYERS_REDIRECT_URI);
fyers.setAccessToken(process.env.FYERS_ACCESS_TOKEN);

// ---------- QUOTES ----------
export async function getQuotesV3(symbols: string[]) {
  return fyers.getQuotes(symbols);
}

// ---------- HELPERS ----------
const toSideNum = (side: "BUY" | "SELL") => (side === "BUY" ? 1 : -1);

function ensurePositive(n: number, name: string) {
  if (!(n > 0)) throw new Error(`${name} must be > 0, got ${n}`);
}

function validateLimit(payload: { limitPrice: number }) {
  ensurePositive(payload.limitPrice, "limitPrice");
}

// ---------- TYPES ----------
type Product = "INTRADAY" | "CNC" | "NRML";
type Validity = "DAY" | "IOC";

export type OrderStatusRow = {
  id?: string;
  status?: string; // PENDING/OPEN/REJECTED/TRADED/FILLED/...
  symbol?: string;
  side?: number;
  qty?: number;
  limitPrice?: number;
};

export type CancelResult =
  | { ok: true; raw: any }
  | { notPending: true; raw: any }
  | { error: true; raw: any };

// Type guards (so TS can narrow cleanly)
export function isCancelOk(r: CancelResult | undefined): r is { ok: true; raw: any } {
  return !!r && (r as any).ok === true;
}
export function isCancelNotPending(
  r: CancelResult | undefined
): r is { notPending: true; raw: any } {
  return !!r && (r as any).notPending === true;
}
export function isCancelError(r: CancelResult | undefined): r is { error: true; raw: any } {
  return !!r && (r as any).error === true;
}

// ---------- ORDERS ----------

/**
 * Place a LIMIT order (type=1). limitPrice is sanitized & validated.
 */
export async function placeLimitOrderV3(params: {
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  limitPrice: number;
  productType?: Product;
  validity?: Validity;
}) {
  const limit = atLeastOneTick(params.limitPrice);
  const payload = {
    symbol: params.symbol,
    qty: params.qty,
    type: 1, // LIMIT
    side: toSideNum(params.side),
    productType: params.productType ?? "INTRADAY",
    limitPrice: roundToTick(limit),
    stopPrice: 0,
    validity: params.validity ?? "DAY",
    disclosedQty: 0,
    offlineOrder: false,
  };

  validateLimit(payload);

  console.log(`[${nowIST()}] [FYERS place_order][LIMIT] payload: ${JSON.stringify(payload)}`);

  const res = await fyers.place_order(payload);
  if (res?.s !== "ok") {
    console.error(`[${nowIST()}] [FYERS place_order][LIMIT] error:`, res);
    throw new Error(`place_limit failed: ${JSON.stringify(res)}`);
  }
  return res;
}

/**
 * Cancel an order by id. Returns a discriminated union.
 */
export async function cancelOrderV3(orderId?: string): Promise<CancelResult | undefined> {
  if (!orderId) return;
  try {
    console.log(`[${nowIST()}] [FYERS cancel_order] id=${orderId}`);
    const res = await fyers.cancel_order({ id: orderId });
    if (res?.s === "ok") return { ok: true, raw: res };

    if (res?.code === -52) {
      console.log(
        `[${nowIST()}] [FYERS cancel_order] ignored (-52): already not pending (${orderId})`
      );
      return { notPending: true, raw: res };
    }

    console.warn(`[${nowIST()}] [FYERS cancel_order] response:`, res);
    return { error: true, raw: res };
  } catch (e: any) {
    const txt = e?.message || String(e);
    if (txt.includes("Not a pending order") || txt.includes('"code":-52')) {
      console.log(
        `[${nowIST()}] [FYERS cancel_order] ignored (-52): already not pending (${orderId})`
      );
      return { notPending: true, raw: e };
    }
    console.error(`[${nowIST()}] [FYERS cancel_order] error:`, e);
    return { error: true, raw: e };
  }
}

/**
 * Try to read the orderbook and find an order by id.
 * NOTE: SDK method names vary; this tries orderbook()/orders() if present.
 */
export async function getOrderStatus(orderId: string): Promise<OrderStatusRow | undefined> {
  try {
    if (typeof fyers.orderbook === "function") {
      const ob = await fyers.orderbook();
      const list: any[] = ob?.orderBook || ob?.orders || [];
      return list.find((o) => o?.id === orderId);
    }
  } catch {
    console.log(`[${nowIST()}] [FYERS getOrderStatus] orderbook() not available / failed`);
  }

  try {
    if (typeof fyers.orders === "function") {
      const ob2 = await fyers.orders();
      const list2: any[] = ob2?.orderBook || ob2?.orders || [];
      return list2.find((o) => o?.id === orderId);
    }
  } catch {
    console.log(`[${nowIST()}] [FYERS getOrderStatus] orders() not available / failed`);
  }

  return undefined;
}
