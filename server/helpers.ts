export const roundToTick = (price: number, tick = 0.05) =>
  Math.round(price / tick) * tick;