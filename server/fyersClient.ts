// server/fyersClient.ts
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
dotenv.config();

const { fyersModel: FyersAPI } = require("fyers-api-v3");

// ensure logs dir
const logPath = path.resolve(__dirname, "../fyers_logs");
if (!fs.existsSync(logPath)) fs.mkdirSync(logPath, { recursive: true });

// single SDK instance
const fyers = new FyersAPI({ path: logPath });
fyers.setAppId(process.env.FYERS_APP_ID);
fyers.setRedirectUrl(process.env.FYERS_REDIRECT_URI);
fyers.setAccessToken(process.env.FYERS_ACCESS_TOKEN);

// ---- QUOTES (unchanged) ----
export async function getQuotesV3(symbols: string[]) {
  return fyers.getQuotes(symbols);
}

// ---- HELPERS ----
const sideNum = (side: "BUY" | "SELL") => (side === "BUY" ? 1 : -1);

// ---- ORDERS: use fyers.place_order (no constructors) ----
type Product = "INTRADAY" | "CNC" | "NRML";
type Validity = "DAY" | "IOC";

/** LIMIT order: type=1 */
export async function placeLimitOrderV3(params: {
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  limitPrice: number;
  productType?: Product;
  validity?: Validity;
}) {
  const payload = {
    symbol: params.symbol,
    qty: params.qty,
    type: 1, // LIMIT
    side: sideNum(params.side),
    productType: params.productType ?? "INTRADAY",
    limitPrice: params.limitPrice,
    stopPrice: 0,
    validity: params.validity ?? "DAY",
    disclosedQty: 0,
    offlineOrder: false,
  };
  const res = await fyers.place_order(payload);
  if (res?.s !== "ok") throw new Error(`place_limit failed: ${JSON.stringify(res)}`);
  return res;
}

/** SL-LIMIT order: type=3 (opposite side) */
export async function placeStopLossLimitV3(params: {
  symbol: string;
  hedgeSide: "BUY" | "SELL";
  qty: number;
  trigger: number; // stopPrice
  slPrice: number; // limitPrice for SL-L
  productType?: Product;
  validity?: Validity;
}) {
  const payload = {
    symbol: params.symbol,
    qty: params.qty,
    type: 3, // SL LIMIT
    side: sideNum(params.hedgeSide),
    productType: params.productType ?? "INTRADAY",
    limitPrice: params.slPrice,
    stopPrice: params.trigger,
    validity: params.validity ?? "DAY",
    disclosedQty: 0,
    offlineOrder: false,
  };
  const res = await fyers.place_order(payload);
  if (res?.s !== "ok") throw new Error(`place_sl_limit failed: ${JSON.stringify(res)}`);
  return res;
}

export { fyers };
