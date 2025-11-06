// server/helpers.ts

/**
 * Round a price to the nearest tick and remove FP artifacts (e.g., 29.150000000000002 → 29.15).
 * Default tick = 0.05 for NSE options.
 */
export function roundToTick(price: number, tick = 0.05): number {
  const v = Math.round(price / tick) * tick;
  return Number(v.toFixed(2));
}

/** Guard against zero/negative accidental prices (use min one-tick). */
export function atLeastOneTick(price: number, tick = 0.05): number {
  const p = roundToTick(price, tick);
  return p > 0 ? p : tick;
}

/** Return current time as HH:MM:SS in IST (Asia/Kolkata). */
export function nowIST(): string {
  // Keep just time (24h) in IST; pad to HH:MM:SS
  const s = new Date().toLocaleTimeString("en-GB", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return s; // e.g., "06:39:07"
}
