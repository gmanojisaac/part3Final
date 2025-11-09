// server/quantityCalc.ts
// Lot sizes (guards)
const LOTS: Record<string, number> = {
  NIFTY: 75,
  BANKNIFTY: 35,
};

export function lotSizeForUnderlying(underlying: string): number {
  const k = underlying.toUpperCase();
  return LOTS[k] ?? 1;
}

/** Round to nearest lot for a target notional (₹) */
export function calculateQuantityForOrderValue(
  underlying: string,
  ltp: number,
  orderValue: number
) {
  const lot = lotSizeForUnderlying(underlying);
  const lots = Math.max(1, Math.round(orderValue / (ltp * lot)));
  return lots * lot;
}
