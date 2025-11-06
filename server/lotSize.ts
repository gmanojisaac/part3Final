const LOT_SIZES: Record<string, number> = {
  NIFTY: 75,
  BANKNIFTY: 35,
};

export function getLotSize(underlying: string): number {
  const lot = LOT_SIZES[underlying.toUpperCase()];
  if (!lot) throw new Error(`Unsupported underlying: ${underlying}`);
  return lot;
}

export function assertLotMultiple(underlying: string, qty: number) {
  const lot = getLotSize(underlying);
  if (qty % lot !== 0) {
    throw new Error(`Qty ${qty} not a multiple of lot ${lot} for ${underlying}`);
  }
}
