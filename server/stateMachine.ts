// server/stateMachine.ts
//
// TradeStateMachine
// - 60s BUY/SELL windows with single exit per window
// - Entry TTL re-place
// - Qty = floor(ORDER_VALUE / LTP)
// - Mode-aware order payloads: include productType only in LIVE mode
// - No-flip exit: exit qty equals current open position
//
// Env:
//   ENTRY_TTL_MS (default 15000)
//   ENTRY_OFFSET, EXIT_OFFSET (default 0.5)
//   ORDER_VALUE (default 3000)

import {
  isPaper,
  getQuotesV3,
  placeLimitOrderV3,
  cancelOrderV3,
  getOrderStatusV3,
  isOrderPending,
  getOpenQty, // ← for no-flip exit
} from "./fyersClient";

type Signal = "BUY_SIGNAL" | "SELL_SIGNAL";
type Side = "BUY" | "SELL";

type MachineOpts = {
  symbol: string;      // FYERS symbol e.g. "NSE:NIFTY25N1125600CE"
  underlying: string;  // pretty/original symbol (for logs)
  orderValue?: number; // INR budget per entry
  slPoints?: number;   // reserved for SL logic if you enable later
};

type WindowType = "BUY" | "SELL";
type State = "IDLE" | "LONG_ACTIVE";

export class TradeStateMachine {
  symbol: string;
  underlying: string;

  state: State = "IDLE";

  // RUN CONFIG
  orderValue: number;
  entryOffset: number;
  exitOffset: number;
  entryTTLms: number;

  // WINDOW
  currentWindow: WindowType | null = null;
  windowIdx = 0;
  windowEndsAt = 0;
  windowTimer: NodeJS.Timeout | null = null;

  // ENTRY MGMT
  entryOrderId: string | null = null;
  entryPlacedAt = 0;
  fillsThisWindow = 0;
  savedBUYLTP: number | null = null;

  // EXIT MGMT
  exitOrderId: string | null = null;
  singleExitConsumed = false;

  constructor(opts: MachineOpts) {
    this.symbol = opts.symbol;
    this.underlying = opts.underlying;

    this.orderValue = Number(process.env.ORDER_VALUE || opts.orderValue || 3000);
    this.entryOffset = Number(process.env.ENTRY_OFFSET || 0.5);
    this.exitOffset = Number(process.env.EXIT_OFFSET || 0.5);
    this.entryTTLms = Number(process.env.ENTRY_TTL_MS || 15000);

    this.log(`[INIT] StateMachine created`);
  }

  getState() {
    return this.state;
  }

  /* =============== PUBLIC API =============== */

  async onSignal(sig: Signal) {
    const ltp = await this.ensureLTP();
    this.log(`Signal: ${sig} @ LTP=${ltp.toFixed(2)} | state=${this.state}`);

    if (sig === "BUY_SIGNAL") {
      this.startBuyWindow(ltp);
      await this.tryEnterLong(ltp);
    } else {
      // SELL signal
      this.startSellWindow(ltp);

      if (this.state === "LONG_ACTIVE") {
        // Immediate exit if holding a long (no flip)
        await this.exitLongImmediate(ltp);
      } else {
        // No position → SELL window just defers a BUY window after it ends
      }
    }
  }

  /* =============== WINDOWS =============== */

  private startBuyWindow(ltp: number) {
    this.windowIdx += 1;
    this.currentWindow = "BUY";
    this.windowEndsAt = Date.now() + 60_000;
    this.fillsThisWindow = 0;
    this.savedBUYLTP = ltp;
    this.singleExitConsumed = false;

    this.log(`[BUY WINDOW] start 60s (idx=${this.windowIdx}) until ${this.ts(this.windowEndsAt)} | savedBUYLTP=${ltp.toFixed(2)}`);
    this.armWindowTimer();
  }

  private startSellWindow(ltp: number) {
    this.currentWindow = "SELL";
    this.windowEndsAt = Date.now() + 60_000;

    this.log(`[SELL WINDOW] start 60s until ${this.ts(this.windowEndsAt)} | anchor=${ltp.toFixed(2)} (BUY deferred to end)`);
    this.armWindowTimer();
  }

  private armWindowTimer() {
    if (this.windowTimer) clearTimeout(this.windowTimer);
    const ms = Math.max(0, this.windowEndsAt - Date.now());
    this.windowTimer = setTimeout(() => this.onWindowEnd(), ms);
  }

  private async onWindowEnd() {
    this.log(`[WINDOW END] ${this.currentWindow} window ended`);

    const ended = this.currentWindow;
    this.currentWindow = null;
    this.entryOrderId = null; // safety
    this.exitOrderId = null;

    if (ended === "SELL") {
      // Auto-start a BUY window after SELL window ends
      const ltp = await this.ensureLTP();
      this.startBuyWindow(ltp);
      await this.tryEnterLong(ltp);
    }
  }

  /* =============== ENTRY / EXIT =============== */

  private computeQty(ltp: number): number {
    const raw = Math.floor(this.orderValue / Math.max(1, Math.round(ltp)));
    return Math.max(1, raw);
  }

  private async tryEnterLong(ltp: number) {
    if (this.currentWindow !== "BUY") return;

    const qty = this.computeQty(ltp);
    const buyLimit = Number((ltp + this.entryOffset).toFixed(2));

    this.log(`[ENTER LONG] window=BUY nextFill=${this.fillsThisWindow + 1} qty=${qty}, LIMIT=${buyLimit}, LTP=${ltp}`);

    const req = {
      symbol: this.symbol,
      side: "BUY" as const,
      qty,
      limitPrice: buyLimit,
      ...(isPaper() ? {} : { productType: "INTRADAY" }),
    };

    const entry = await placeLimitOrderV3(req);
    this.entryOrderId = entry?.id || null;
    this.entryPlacedAt = Date.now();

    // arm TTL watcher
    setTimeout(() => this.checkEntryTTL(), this.entryTTLms);
  }

  private async checkEntryTTL() {
    if (!this.entryOrderId) return;
    const id = this.entryOrderId;

    try {
      const st = await getOrderStatusV3(id);
      if (!st.found) return;
      if (!isOrderPending(st.status)) {
        this.log(`[ENTRY TTL] status=${(st as any).status || st} → no re-place`);
        if (String((st as any).status || st).toUpperCase() === "FILLED") this.onEntryFilled();
        return;
      }
    } catch {
      // ignore; will try to re-place optimistically
    }

    // cancel & re-place at fresh limit
    this.log(`[ENTRY TTL] cancelling stale entry ${id} and (maybe) re-placing...`);
    try { await cancelOrderV3(id); } catch {}
    this.entryOrderId = null;

    // Respect window still open
    if (this.currentWindow !== "BUY") return;

    const ltp = await this.ensureLTP();
    const qty = this.computeQty(ltp);
    const newLimit = Number((ltp + this.entryOffset).toFixed(2));

    const re = await placeLimitOrderV3({
      symbol: this.symbol,
      side: "BUY",
      qty,
      limitPrice: newLimit,
      ...(isPaper() ? {} : { productType: "INTRADAY" }),
    });
    this.entryOrderId = re?.id || null;
    this.log(`[ENTRY TTL] re-placed entry order=${this.entryOrderId} @ limit=${newLimit}`);
  }

  private onEntryFilled() {
    this.fillsThisWindow += 1;
    this.state = "LONG_ACTIVE";
    this.log(`[FILL] Entry filled → LONG_ACTIVE (fills this window=${this.fillsThisWindow})`);
  }

  private async exitLongImmediate(ltp: number) {
    if (this.state !== "LONG_ACTIVE") return;

    // Exact open qty → no flip
    const openQty = Math.abs(getOpenQty(this.symbol));
    if (openQty <= 0) {
      this.log(`[SELL WINDOW] requested exit but already flat → skipping`);
      return;
    }

    const sellLimit = Number((ltp - this.exitOffset).toFixed(2));
    const qty = openQty;

    this.log(`[SELL WINDOW] active position → immediate exit @ (ltp-${this.exitOffset}); BUY window will start after SELL window ends`);

    const ex = await placeLimitOrderV3({
      symbol: this.symbol,
      side: "SELL",
      qty,
      limitPrice: sellLimit,
      ...(isPaper() ? {} : { productType: "INTRADAY" }),
    });
    this.exitOrderId = ex?.id || null;

    this.log(`[EXIT LONG] reason=SELL_WINDOW_IMMEDIATE_EXIT, qty=${qty}, limit=${sellLimit}, LTP=${ltp}`);

    // Cancel any stale entry still around
    if (this.entryOrderId) {
      this.log(`Cancelling entry order id=${this.entryOrderId}`);
      try { await cancelOrderV3(this.entryOrderId); } catch {}
      this.entryOrderId = null;
    }
    this.singleExitConsumed = true;
  }

  // Kept for future use; now prefers exact open qty.
  private computeQtyFromPnLContext(): number {
    const openQty = Math.abs(getOpenQty(this.symbol));
    if (openQty > 0) return openQty;
    return this.computeQty(Math.max(1, this._lastKnownLTP || 1));
  }

  /* =============== LTP / QUOTES =============== */

  private _lastKnownLTP: number | null = null;

  private async ensureLTP(): Promise<number> {
    const q = await getQuotesV3(this.symbol);
    const l = (q as any)?.d?.[0]?.v?.lp;
    if (l == null || !Number.isFinite(Number(l))) {
      throw new Error(`LTP not found for ${this.symbol}`);
    }
    this._lastKnownLTP = Number(l);
    return Number(l);
  }

  /* =============== UTIL =============== */

  private ts(ms: number) {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  log(msg: string) {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const hhmmss = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    console.log(`[${hhmmss}] [${this.symbol}] ${msg}`);
  }
}
