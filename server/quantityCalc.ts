// server/quantityCalc.ts
import { getLotSize } from "./lotSize";

/**
 * Calculate quantity (rounded to nearest lot) for a target notional value
 * e.g. Rs.1L worth of exposure per trade
 */
export function calculateQuantityForOrderValue(
  underlying: string,
  ltp: number,
  targetValue = Number(process.env.ORDER_VALUE ?? 100000)  // 100000 // default 
): number {
  if (ltp <= 0) throw new Error(`Invalid LTP: ${ltp}`);

  const lot = getLotSize(underlying);
  // number of lots (rounded to nearest)
  const numLots = Math.max(1, Math.round(targetValue / (ltp * lot)));
  const quantity = numLots * lot;

  return quantity;
}
