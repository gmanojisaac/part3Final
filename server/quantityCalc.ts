import { getLotSize } from "./lotSize";

export function calculateQuantityForOrderValue(
  underlying: string,
  ltp: number,
  targetValue = Number(process.env.ORDER_VALUE ?? 100000)
): number {
  if (ltp <= 0) throw new Error(`Invalid LTP: ${ltp}`);
  const lot = getLotSize(underlying);
  const numLots = Math.max(1, Math.round(targetValue / (ltp * lot)));
  return numLots * lot;
}
