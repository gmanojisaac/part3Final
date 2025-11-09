// server/dataSocket.ts
import EventEmitter from "events";
import { onTickFromMarket } from "./fyersClient";

/**
 * Tick shape normalized for the app
 */
export type Tick = {
  symbol: string;
  ltp: number;
  ts: number; // epoch ms
};

type TickListener = (symbol: string, ltp: number, ts: number) => void;

/**
 * DataSocket:
 * - Owns the broker WS connection (implement your actual FYERS WS here)
 * - Emits normalized ticks to listeners
 * - Always forwards ticks to paper broker (if PAPERTRADE=true)
 */
class DataSocket extends EventEmitter {
  private subscriptions = new Map<string, number>(); // symbol -> refcount
  private connected = false;

  /** Connect to broker feed (idempotent) */
  async connect(): Promise<void> {
    if (this.connected) return;
    // TODO: wire your actual FYERS WS client here and call this.handleIncomingTick(...)
    // For example:
    // this.brokerWs.on("tick", (raw) => this.handleIncomingTick(normalize(raw)));
    this.connected = true;
  }

  /** Subscribe to a symbol; returns an unsubscribe function */
  async subscribe(symbol: string, listener?: TickListener): Promise<() => void> {
    await this.connect();
    const count = this.subscriptions.get(symbol) ?? 0;
    this.subscriptions.set(symbol, count + 1);
    if (listener) {
      this.on("tick", (sym, ltp, ts) => {
        if (sym === symbol) listener(sym, ltp, ts);
      });
    }
    // TODO: if count was 0 -> send subscribe request to FYERS WS for this symbol
    return () => this.unsubscribe(symbol, listener);
  }

  /** Unsubscribe; will unref WS symbol when refcount hits 0 */
  unsubscribe(symbol: string, listener?: TickListener) {
    if (listener) {
      // remove specific bound listener (EventEmitter doesn't support predicate removal easily)
      // Consumers that pass listener should keep their own off() if needed; we keep it simple here.
    }
    const count = this.subscriptions.get(symbol) ?? 0;
    const next = Math.max(0, count - 1);
    if (next === 0) {
      this.subscriptions.delete(symbol);
      // TODO: send unsubscribe request to FYERS WS for this symbol
    } else {
      this.subscriptions.set(symbol, next);
    }
  }

  /** Central place to dispatch ticks to the app + paper broker */
  private handleIncomingTick(t: Tick) {
    // Fanout to listeners
    this.emit("tick", t.symbol, t.ltp, t.ts);

    // Always feed paper broker to simulate order fills/P&L in paper mode.
    onTickFromMarket(t.symbol, t.ltp);
  }

  /* -----------------------------------------------------------------------
   * Public helper if you want to inject ticks (useful for tests)
   * ---------------------------------------------------------------------*/
  injectTick(symbol: string, ltp: number, ts: number = Date.now()) {
    this.handleIncomingTick({ symbol, ltp, ts });
  }
}

export const dataSocket = new DataSocket();
