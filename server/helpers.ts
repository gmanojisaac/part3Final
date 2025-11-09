// server/helpers.ts
export function nowIST() {
  return new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" });
}

// NSE options tick is 0.05
const TICK = 0.05;

export function roundToTick(price: number) {
  const n = Math.round(price / TICK) * TICK;
  return Number(n.toFixed(2));
}

export function atLeastOneTick(price: number) {
  const p = Number(price);
  if (p <= 0) return TICK;
  return p;
}
