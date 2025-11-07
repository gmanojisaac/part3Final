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

/**
 * Positions wrapper compatible across SDK variants.
 * Returns a normalized shape: { s, netPositions: [] }
 */
export async function getPositionsV3(): Promise<{ s: string; netPositions: any[] }> {
  let raw: any;

  if (typeof fyers.get_positions === "function") {
    raw = await fyers.get_positions();
  } else if (typeof fyers.positions === "function") {
    raw = await fyers.positions();
  } else if (typeof fyers.positionsV2 === "function") {
    raw = await fyers.positionsV2();
  } else {
    throw new Error(
      "FYERS SDK: no positions function found (expected get_positions / positions / positionsV2)."
    );
  }

  const netPositions =
    raw?.netPositions ??
    raw?.net_positions ??
    raw?.data?.netPositions ??
    raw?.data?.net_positions ??
    raw?.data ??
    [];

  return { s: raw?.s ?? "ok", netPositions: Array.isArray(netPositions) ? netPositions : [] };
}

// ---------- ORDERS / STATUS ----------
/** Normalize to a *string* status. Also coerce some numeric codes. */
function normalizeOrderStatus(row: any): string {
  const raw = row?.status ?? row?.orderStatus ?? row?.order_status ?? row?.orderstatus;
  if (raw == null) return "";

  // If numeric (or numeric-like), map what we know:
  // Empirically from your logs: 2 => FILLED
  const n = Number(raw);
  if (!Number.isNaN(n)) {
    if (n === 2) return "FILLED";
    // Unknown codes → return as string to avoid misclassification
    return String(raw);
  }
  return String(raw).toUpperCase();
}

/**
 * Try multiple methods to fetch today's orders and find a specific order by id.
 * Normalizes the output and returns { found, row, status }.
 */
export async function getOrderStatusV3(orderId: string): Promise<{
  found: boolean;
  status?: string;
  row?: any;
}> {
  let raw: any;

  if (typeof fyers.get_orders === "function") {
    raw = await fyers.get_orders();
  } else if (typeof fyers.orders === "function") {
    raw = await fyers.orders();
  } else if (typeof fyers.orderbook === "function") {
    raw = await fyers.orderbook();
  } else if (typeof fyers.get_orderbook === "function") {
    raw = await fyers.get_orderbook();
  } else {
    console.warn("[getOrderStatusV3] No orders function in SDK");
    return { found: false };
  }

  const list: any[] =
    raw?.orders ??
    raw?.orderBook ??
    raw?.data ??
    raw?.orderbook ??
    raw?.orderbook_v2 ??
    [];

  const row = list.find((r: any) => {
    const id = String(r?.id ?? r?.orderId ?? r?.order_id ?? "");
    return id === String(orderId);
  });

  if (!row) return { found: false };

  const status = normalizeOrderStatus(row);
  return { found: true, status, row };
}

/** Heuristic pending check across FYERS status variants */
export function isOrderPending(status?: string) {
  if (!status) return false;
  const s = String(status).toUpperCase();
  return ["PENDING", "OPEN", "OPEN PENDING", "OPEN_PENDING", "TRIGGER PENDING", "TRIGGER_PENDING"]
    .includes(s);
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

// ---------- ORDER PLACE / CANCEL ----------
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
    type: 1,
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

export async function cancelOrderV3(orderId?: string) {
  if (!orderId) return;
  try {
    console.log(`[${nowIST()}] [FYERS cancel_order] id=${orderId}`);
    const res = await fyers.cancel_order({ id: orderId });
    if (res?.s !== "ok" && res?.code !== -52) {
      console.warn(`[${nowIST()}] [FYERS cancel_order] response:`, res);
    } else if (res?.code === -52) {
      console.log(
        `[${nowIST()}] [FYERS cancel_order] ignored (-52): already not pending (${orderId})`
      );
    }
    return res;
  } catch (e) {
    console.error(`[${nowIST()}] [FYERS cancel_order] error:`, e);
  }
}
