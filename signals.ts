import { Tick } from "./types";

export type SignalRow = { time: Date; symbol: string; signal: "BUY" | "SELL" };

/**
 * Merge history ticks with signal events:
 * produces a continuous stream of ticks where some ticks also carry a signal.
 */
export function mergeTicksAndSignals(historyTicks: Tick[], signals: SignalRow[]): Tick[] {
  const key = (s: string, d: Date) => `${s}|${d.toISOString()}`;
  const sigMap = new Map<string, SignalRow[]>();

  for (const s of signals) {
    const k = key(s.symbol, s.time);
    const list = sigMap.get(k) ?? [];
    list.push(s);
    sigMap.set(k, list);
  }

  const out: Tick[] = [];
  for (const t of historyTicks) {
    const list = sigMap.get(key(t.symbol, t.time));
    if (list && list.length) {
      for (const s of list) out.push({ ...t, signal: s.signal });
    } else {
      out.push(t);
    }
  }
  return out;
}
