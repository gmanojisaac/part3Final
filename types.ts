// ============================================
// file: types.ts
// ============================================

export type Side = "BUY" | "SELL";

/** Tick from history + signal injection */
export type Tick = {
  time: Date;            // JS Date (UTC)
  symbol: string;        // e.g., "NSE:NIFTY251111C25700"
  ltp: number;           // last traded price
  signal?: Side | "";    // optional BUY/SELL signal
};

/** Trade Fill */
export type Fill = {
  qty: number;
  price: number;
  time: Date;
};

/** One trade (entry + optional exit) */
export type Trade = {
  id: string;
  symbol: string;
  entry: Fill;
  exit?: Fill;
  reason?: "signal-exit" | "stop-loss";
  pnl?: number;
};

/** State-machine event payload */
export type EngineEvent =
  | { type: "entered"; trade: Trade }
  | { type: "exited"; trade: Trade }
  | { type: "stop-loss"; trade: Trade }
  | { type: "cooldown-enter"; symbol: string; until: Date; prevSavedLTP: number }
  | { type: "cooldown-extend"; symbol: string; until: Date }
  | { type: "cooldown-exit"; symbol: string }
  | { type: "log"; message: string };

/** Generic Result pattern (used for stubs or API responses) */
export type Result<T> =
  | { status: "ok"; value: T }
  | { status: "error"; error: Error };

/** Stable unique ID generator for trades, etc. */
export const uid = (() => {
  let n = 0;
  return (prefix = "id") => `${prefix}-${++n}`;
})();
