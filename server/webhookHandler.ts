import { parseWebhookLine } from "./parseWebhook";
import { getQuotesV3, placeLimitOrderV3, placeStopLossLimitV3 } from "./fyersClient";
import { roundToTick } from "./helpers";
import { calculateQuantityForOrderValue } from "./quantityCalc";

export async function handleWebhook(body: any) {
  const line: string = typeof body === "string" ? body : (body.text ?? "");
  if (!line) throw new Error("No webhook text payload");

  const parsed = parseWebhookLine(line);
  const { fyersSymbol, action, meta } = parsed;

  const side = action === "ENTRY" ? "BUY" : "SELL";

  // 1️⃣ Fetch LTP
  const q = await getQuotesV3([fyersSymbol]);
  const ltp = q?.d?.[0]?.v?.lp;
  if (!ltp) throw new Error(`LTP not found for ${fyersSymbol}`);

  // 2️⃣ Compute quantity for ₹1L exposure
  const qty = calculateQuantityForOrderValue(meta.underlying, ltp);
  console.log(`Qty calc: 1L / (LTP ₹${ltp}) → qty=${qty}`);

  // 3️⃣ Compute entry/SL prices
  const sideMul = side === "BUY" ? 1 : -1;
  const limit = roundToTick(ltp + sideMul * 0.5);
  const sl_points = 0.5;

  // 4️⃣ Place entry
  const entryRes = await placeLimitOrderV3({
    symbol: fyersSymbol,
    side,
    qty,
    limitPrice: limit,
    productType: "INTRADAY",
    validity: "DAY"
  });
  console.log("ENTRY:", entryRes);

  // 5️⃣ Place SL-Limit
  const trigger = side === "BUY" ? limit - sl_points : limit + sl_points;
  const slPrice = side === "BUY" ? trigger - 0.5 : trigger + 0.5;

  const slRes = await placeStopLossLimitV3({
    symbol: fyersSymbol,
    hedgeSide: side === "BUY" ? "SELL" : "BUY",
    qty,
    trigger,
    slPrice,
    productType: "INTRADAY",
    validity: "DAY"
  });
  console.log("SL:", slRes);

  console.log(
    `[${action}] ${fyersSymbol} | LTP=${ltp} | qty=${qty} | entry=${limit} | SL=${slPrice}`
  );
}
