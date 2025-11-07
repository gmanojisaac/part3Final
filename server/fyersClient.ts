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
 * Positions wrapper that is compatible across SDK variants.
 * Tries get_positions() first (preferred), then positions(), then positionsV2() if present.
 * Returns a normalized shape: { s, netPositions: [...] }
 */
export async function getPositionsV3(): Promise<{ s: string; netPositions: any[] }> {
  let raw: any;

  // Prefer get_positions() if available
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

  // Normalize common variants
  const netPositions =
    raw?.netPositions ??
    raw?.net_positions ??
    raw?.data?.netPositions ??
    raw?.data?.net_positions ??
    raw?.data ??
    [];

  return { s: raw?.s ?? "ok", netPositions: Array.isArray(netPositions) ? netPositions : [] };
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

// ---------- ORDERS ----------
/**
 * Place a LIMIT order (type=1). limitPrice is sanitized & validated.
 * Prints a timestamped [FYERS place_order][LIMIT] payload in IST.
 */
export async function placeLimitOrderV3(params: {
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  limitPrice: number;
  productType?: Product;
  validity?: Validity;
}) {
  const limit = atLeastOneTick(params.limitPrice); // sanitize + non-zero
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

  // Timestamped debug line in IST
  console.log(
    `[${nowIST()}] [FYERS place_order][LIMIT] payload: ${JSON.stringify(payload)}`
  );

  const res = await fyers.place_order(payload);
  if (res?.s !== "ok") {
    console.error(`[${nowIST()}] [FYERS place_order][LIMIT] error:`, res);
    throw new Error(`place_limit failed: ${JSON.stringify(res)}`);
  }
  return res; // { id: "...", ... }
}

/**
 * Cancel an order by id. Ignores -52 "Not a pending order" (already filled/cancelled).
 * Prints timestamped cancel attempts.
 */
export async function cancelOrderV3(orderId?: string) {
  if (!orderId) return;
  try {
    console.log(`[${nowIST()}] [FYERS cancel_order] id=${orderId}`);
    const res = await fyers.cancel_order({ id: orderId });
    if (res?.s !== "ok") {
      if (res?.code === -52) {
        console.log(
          `[${nowIST()}] [FYERS cancel_order] ignored (-52): already not pending (${orderId})`
        );
        return res;
      }
      console.warn(`[${nowIST()}] [FYERS cancel_order] response:`, res);
    }
    return res;
  } catch (e: any) {
    const txt = e?.message || String(e);
    if (txt.includes("Not a pending order") || txt.includes('"code":-52')) {
      console.log(
        `[${nowIST()}] [FYERS cancel_order] ignored (-52): already not pending (${orderId})`
      );
      return;
    }
    console.error(`[${nowIST()}] [FYERS cancel_order] error:`, e);
  }
}
