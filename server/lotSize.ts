// server/lotSize.ts

const LOT_SIZES: Record<string, number> = {
  NIFTY: 75,
  BANKNIFTY: 35,
  // add more here if needed, e.g. FINNIFTY: 40
};

export function getLotSize(underlying: string): number {
  const u = underlying.toUpperCase();
  const lot = LOT_SIZES[u];
  if (!lot) throw new Error(`Unsupported underlying for lot size: ${underlying}`);
  return lot;
}

/** Guard that a quantity is a multiple of the lot size */
export function assertLotMultiple(underlying: string, qty: number) {
  const lot = getLotSize(underlying);
  if (qty % lot !== 0) {
    throw new Error(
      `Qty ${qty} not a multiple of lot ${lot} for ${underlying}.` +
      ` Use a multiple of ${lot}.`
    );
  }
  return lot;
}
