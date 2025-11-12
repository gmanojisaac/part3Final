/* eslint-disable no-console */

// ─────────────────────────────────────────────────────────────────────────────
// Updated state machine to match latest spec:
//
// SELL side
// - Start 60s SELL window on SELL_SIGNAL (both FLAT and IN-POSITION).
// - FLAT path during SELL window:
//     • If tick > (sellLtp + 0.5) → cancel SELL, start BUY with savedBUYLTP = (sellLtp + 0.5) + 0.5.
//     • Else if sellStartBuyAnchor is set AND tick < sellStartBuyAnchor →
//         cancel SELL, start BUY with savedBUYLTP = sellStartBuyAnchor.
// - IN-POSITION path during SELL window:
//     • On first tick(s) → EXIT full qty @ (tick - 0.5); then do NOTHING else until window end.
// - SELL window timeout → re-start a fresh 60s SELL window (loop back to A),
//   anchoring at current LTP, and re-checking position status.
//
// BUY side
// - On BUY_SIGNAL:
//     • If first BUY after a SELL → sellStartBuyAnchor = buyLtp.
//     • savedBUYLTP = forcedAnchor (if provided) else buyLtp.
//     • Immediately place BUY LIMIT @ (savedBUYLTP + 0.5).
//     • If state == IDLE → start 60s BUY window.
// - During BUY window (live ticks):
//     • If tick < (savedBUYLTP - 0.5) → EXIT full qty @ (tick - 0.5) and go IDLE (no restart).
//     • If FLAT and tick > savedBUYLTP → place BUY LIMIT @ (tick + 0.5) and start a new 60s BUY window.
// - BUY window timeout → go IDLE (loop to A; wait for next signal).
// ─────────────────────────────────────────────────────────────────────────────

import {
  getOpenQty,
  computeQtyFromPnLContext,
  placeLimitBuy,
  placeLimitSell,
  roundPrice,
} from "./fyersClient";
import { onSymbolTick, nowLtp } from "./dataSocket";
import { isMarketOpenNow } from "./marketHours";

// ── Types ────────────────────────────────────────────────────────────────────
export type MachineState = "IDLE" | "IN_BUY_WINDOW" | "IN_SELL_WINDOW";
export interface Signal {
  type: "BUY_SIGNAL" | "SELL_SIGNAL";
  ltp: number;
  ts: number;
  reason?: string;
  raw?: unknown;
}
type TimerHandle = ReturnType<typeof setTimeout> | null;

// ── Log helpers ──────────────────────────────────────────────────────────────
const fmtPx = (n: number | null | undefined) =>
  n == null || Number.isNaN(n) ? "—" : Number(n).toFixed(2);
const fmtTs = (ts: number) => new Date(ts).toTimeString().slice(0, 8);
function log(sym: string, msg: string) {
  console.log(`[${new Date().toTimeString().slice(0, 8)}] [${sym}] ${msg}`);
}
function debug(sym: string, msg: string) {
  console.log(`[${fmtTs(Date.now())}] [${sym}] ${msg}`);
}

// ── Per-symbol anchors/state ─────────────────────────────────────────────────
type PerSymbolAnchorState = {
  // Captured on first BUY after a SELL
  sellStartBuyAnchor: number | null;

  // Anchor used when starting a BUY window (may be forced)
  savedBUYLTP: number | null;

  // Whether the *next* BUY signal is the first after the most recent SELL
  pendingBuyAfterSell: boolean;

  // For observability; not used for logic gates now
  buyWindowIdxSinceSell: number;

  // Optional reason from SELL path
  lastSellReason: string | null;
};

const ANCHOR: Record<string, PerSymbolAnchorState> = {};
function ensureAnchor(sym: string): PerSymbolAnchorState {
  if (!ANCHOR[sym]) {
    ANCHOR[sym] = {
      sellStartBuyAnchor: null,
      savedBUYLTP: null,
      pendingBuyAfterSell: false,
      buyWindowIdxSinceSell: 0,
      lastSellReason: null,
    };
  }
  return ANCHOR[sym];
}

// ── Per-symbol machine ───────────────────────────────────────────────────────
class SymbolMachine {
  readonly sym: string;
  state: MachineState = "IDLE";

  private sellWindowTimer: TimerHandle = null;
  private buyWindowTimer: TimerHandle = null;

  // SELL context
  private sellWindowActive = false;
  private sellWindowDoNothing = false; // freeze actions after in-pos exit
  private sellWindowStartLtp: number | null = null;
  private sellWindowBreakoutPx: number | null = null;
  private hadPositionOnSell = false;

  // BUY context
  private buyWindowActive = false;

  constructor(sym: string) {
    this.sym = sym;
    log(sym, "[INIT] StateMachine created");
  }

  handleSignal(sig: Signal) {
    if (!isMarketOpenNow()) {
      debug(this.sym, "[SKIP] market closed, ignoring signal");
      return;
    }
    if (sig.type === "SELL_SIGNAL") this.onSellSignal(sig);
    else this.onBuySignal(sig);
  }

  // ── SELL handling ──────────────────────────────────────────────────────────
  private onSellSignal(sig: Signal) {
    const openQty = getOpenQty(this.sym);
    this.hadPositionOnSell = openQty > 0;

    log(this.sym, `Signal: SELL_SIGNAL @ LTP=${fmtPx(sig.ltp)} | state=${this.state}`);
    this.startSellWindow(sig.ltp, 60_000, sig.reason ?? "GENERIC");
  }

  private startSellWindow(sellLtp: number, windowMs: number, reason: string) {
    const a = ensureAnchor(this.sym);
    this.clearTimers();

    a.pendingBuyAfterSell = true; // the next BUY signal will capture sellStartBuyAnchor
    a.buyWindowIdxSinceSell = 0;
    a.lastSellReason = reason;

    this.state = "IN_SELL_WINDOW";
    this.sellWindowActive = true;
    this.sellWindowDoNothing = false;
    this.sellWindowStartLtp = sellLtp;
    this.sellWindowBreakoutPx = roundPrice(sellLtp + 0.5);

    const untilTs = Date.now() + windowMs;
    log(
      this.sym,
      `[SELL WINDOW] start 60s until ${fmtTs(untilTs)} | anchor=${fmtPx(
        sellLtp
      )} | breakout>${fmtPx(this.sellWindowBreakoutPx)} | hadPos=${this.hadPositionOnSell}`
    );

    // Live tick watcher for SELL window
    onSymbolTick(this.sym, (tickLtp: number) => {
      if (!this.sellWindowActive) return;

      if (this.hadPositionOnSell && !this.sellWindowDoNothing) {
        // IN-POSITION immediate exit on first ticks, then freeze.
        const q = getOpenQty(this.sym);
        if (q > 0) {
          const px = roundPrice(tickLtp - 0.5);
          debug(
            this.sym,
            `[SELL IN-POS EXIT] EXIT qty=${q} @ LIMIT=${fmtPx(px)} (tick=${fmtPx(tickLtp)}) → freeze until window end`
          );
          placeLimitSell(this.sym, q, px, { tag: "SELL_INPOS_IMMEDIATE_EXIT" });
        } else {
          debug(this.sym, `[SELL IN-POS EXIT] no open qty at execution time`);
        }
        this.sellWindowDoNothing = true;
        return;
      }

      // FLAT path
      if (!this.hadPositionOnSell) {
        const breakoutPx = this.sellWindowBreakoutPx!;
        if (tickLtp > breakoutPx) {
          // cancel SELL → start BUY with savedBUYLTP = breakoutPx + 0.5
          const forcedAnchor = roundPrice(breakoutPx + 0.5); // effectively sellLtp + 1.0
          debug(
            this.sym,
            `[SELL FLAT BREAKOUT] tick=${fmtPx(tickLtp)} > ${fmtPx(
              breakoutPx
            )} → cancel SELL, start BUY (savedBUYLTP=${fmtPx(forcedAnchor)})`
          );
          this.cancelSellWindowTimerOnly();
          this.sellWindowActive = false;
          this.startBuyWindow(forcedAnchor, 60_000, forcedAnchor, /*fromFlatBreakout*/ true);
          return;
        }

        // If sellStartBuyAnchor set and tick < anchor → cancel SELL → BUY with savedBUYLTP = anchor
        if (a.sellStartBuyAnchor != null && tickLtp < a.sellStartBuyAnchor) {
          debug(
            this.sym,
            `[SELL FLAT ANCHOR BREACH] tick=${fmtPx(tickLtp)} < sellStartBuyAnchor=${fmtPx(
              a.sellStartBuyAnchor
            )} → cancel SELL, start BUY (savedBUYLTP=${fmtPx(a.sellStartBuyAnchor)})`
          );
          this.cancelSellWindowTimerOnly();
          this.sellWindowActive = false;
          this.startBuyWindow(a.sellStartBuyAnchor, 60_000, a.sellStartBuyAnchor);
          return;
        }
      }
    });

    // SELL window end → re-start SELL window (loop back to A)
    this.sellWindowTimer = setTimeout(() => {
      this.sellWindowTimer = null;
      this.sellWindowActive = false;
      log(this.sym, `[WINDOW END] SELL window ended → restarting SELL window`);
      const nextAnchor = nowLtp(this.sym) ?? this.sellWindowStartLtp ?? sellLtp;
      // refresh position status and start a new 60s SELL window
      this.hadPositionOnSell = getOpenQty(this.sym) > 0;
      this.startSellWindow(nextAnchor, windowMs, reason);
    }, windowMs);
  }

  private cancelSellWindowTimerOnly() {
    if (this.sellWindowTimer) {
      clearTimeout(this.sellWindowTimer);
      this.sellWindowTimer = null;
    }
  }

  // ── BUY handling ───────────────────────────────────────────────────────────
  private onBuySignal(sig: Signal, forcedAnchor?: number) {
    const a = ensureAnchor(this.sym);

    // First BUY after the most recent SELL captures sellStartBuyAnchor
    if (a.pendingBuyAfterSell) {
      a.sellStartBuyAnchor = sig.ltp;
      a.pendingBuyAfterSell = false;
      debug(this.sym, `[ANCHOR] captured sellStartBuyAnchor=${fmtPx(sig.ltp)} (first BUY after SELL)`);
    }

    // Calculate savedBUYLTP and place immediate buy attempt @ savedBUYLTP + 0.5
    const saved = forcedAnchor ?? sig.ltp;
    a.savedBUYLTP = saved;

    const entryPx = roundPrice(saved + 0.5);
    const qty = computeQtyFromPnLContext(this.sym);
    debug(
      this.sym,
      `[BUY SIGNAL] savedBUYLTP=${fmtPx(saved)} → place BUY LIMIT qty=${qty} @ ${fmtPx(entryPx)}`
    );
    placeLimitBuy(this.sym, qty, entryPx, { tag: "BUY_SIGNAL_PREWINDOW" });

    // If IDLE, start a BUY window
    if (this.state === "IDLE") {
      this.startBuyWindow(sig.ltp, 60_000, saved);
    } else {
      log(this.sym, `[BUY SIGNAL] ignored window start (active window already running)`);
    }
  }

  private startBuyWindow(nowLtpPx: number, windowMs: number, savedAnchor: number, fromFlatBreakout = false) {
    const a = ensureAnchor(this.sym);
    this.clearTimers();

    a.savedBUYLTP = savedAnchor;
    a.buyWindowIdxSinceSell += 1;

    this.state = "IN_BUY_WINDOW";
    this.buyWindowActive = true;

    const untilTs = Date.now() + windowMs;
    log(
      this.sym,
      `[BUY WINDOW] start 60s (idx=${a.buyWindowIdxSinceSell}) until ${fmtTs(
        untilTs
      )} | savedBUYLTP=${fmtPx(savedAnchor)}${fromFlatBreakout ? " (from SELL-flat breakout)" : ""}`
    );

    // Live tick watcher for BUY window
    onSymbolTick(this.sym, (tickLtp: number) => {
      if (!this.buyWindowActive) return;

      // Stop-out: tick < (savedBUYLTP - 0.5) → exit full qty and go IDLE (no restart)
      if (tickLtp < roundPrice(savedAnchor - 0.5)) {
        const q = getOpenQty(this.sym);
        if (q > 0) {
          const px = roundPrice(tickLtp - 0.5);
          debug(
            this.sym,
            `[BUY STOP-OUT] tick=${fmtPx(tickLtp)} < (${fmtPx(savedAnchor)} - 0.5) → EXIT qty=${q} @ LIMIT=${fmtPx(
              px
            )} and go IDLE`
          );
          placeLimitSell(this.sym, q, px, { tag: "BUY_WINDOW_STOP_OUT" });
        } else {
          debug(this.sym, `[BUY STOP-OUT] condition met but no open qty`);
        }
        this.buyWindowActive = false;
        this.state = "IDLE";
        this.cancelBuyWindowTimerOnly();
        return;
      }

      // Flat breakout up: if FLAT and tick > savedBUYLTP → buy @ (tick + 0.5) and start a fresh BUY window
      if (getOpenQty(this.sym) === 0 && tickLtp > savedAnchor) {
        const px = roundPrice(tickLtp + 0.5);
        const qty2 = computeQtyFromPnLContext(this.sym);
        debug(
          this.sym,
          `[BUY FLAT BREAKOUT] tick=${fmtPx(tickLtp)} > savedBUYLTP=${fmtPx(
            savedAnchor
          )} → place BUY LIMIT qty=${qty2} @ ${fmtPx(px)} and restart BUY window`
        );
        placeLimitBuy(this.sym, qty2, px, { tag: "BUY_WINDOW_BREAKOUT_REENTER" });

        // restart a fresh 60s BUY window with same anchor? spec says loop to A (re-evaluate IDLE).
        // We’ll start a new window anchored to current savedBUYLTP (unchanged) and loop.
        this.buyWindowActive = false;
        this.cancelBuyWindowTimerOnly();
        this.state = "IDLE"; // go to A
        // start new BUY window (fresh 60s)
        this.startBuyWindow(tickLtp, windowMs, savedAnchor);
        return;
      }
    });

    // BUY window timeout → go IDLE (loop to A)
    this.buyWindowTimer = setTimeout(() => {
      this.buyWindowTimer = null;
      this.buyWindowActive = false;
      log(this.sym, `[WINDOW END] BUY window ended → IDLE`);
      this.state = "IDLE";
    }, windowMs);
  }

  private cancelBuyWindowTimerOnly() {
    if (this.buyWindowTimer) {
      clearTimeout(this.buyWindowTimer);
      this.buyWindowTimer = null;
    }
  }

  // ── Utilities ──────────────────────────────────────────────────────────────
  private clearTimers() {
    if (this.sellWindowTimer) {
      clearTimeout(this.sellWindowTimer);
      this.sellWindowTimer = null;
    }
    if (this.buyWindowTimer) {
      clearTimeout(this.buyWindowTimer);
      this.buyWindowTimer = null;
    }
    this.sellWindowActive = false;
    this.buyWindowActive = false;
    this.sellWindowDoNothing = false;
    // keep hadPositionOnSell as-is; it’s set at SELL signal time
  }
}

// ── Registry & exports ───────────────────────────────────────────────────────
const MACHINES: Record<string, SymbolMachine> = {};

export function getMachine(sym: string): SymbolMachine {
  if (!MACHINES[sym]) {
    log(sym, "[INIT] machine for " + sym);
    MACHINES[sym] = new SymbolMachine(sym);
  }
  return MACHINES[sym];
}

export function handleSellSignal(sym: string, ltp: number, reason?: string, raw?: unknown) {
  getMachine(sym).handleSignal({ type: "SELL_SIGNAL", ltp, ts: Date.now(), reason, raw });
}
export function handleBuySignal(sym: string, ltp: number, raw?: unknown, forcedAnchor?: number) {
  // pass forcedAnchor into onBuySignal via a wrapper call
  (getMachine(sym) as any).onBuySignal({ type: "BUY_SIGNAL", ltp, ts: Date.now(), raw }, forcedAnchor);
}

// Compatibility class used by webhookHandler (kept)
type LegacyCtorArg =
  | string
  | { symbol: string; underlying?: string; orderValue?: number; slPoints?: number };

export class TradeStateMachine {
  public readonly symbol: string;
  public readonly underlying?: string;
  public readonly orderValue?: number;
  public readonly slPoints?: number;

  constructor(arg: LegacyCtorArg) {
    if (typeof arg === "string") this.symbol = arg;
    else {
      this.symbol = arg.symbol;
      this.underlying = arg.underlying;
      this.orderValue = arg.orderValue;
      this.slPoints = arg.slPoints;
    }
    getMachine(this.symbol);
  }

  sell(ltp: number, reason?: string, raw?: unknown) {
    handleSellSignal(this.symbol, ltp, reason, raw);
  }
  buy(ltp: number, raw?: unknown, forcedAnchor?: number) {
    handleBuySignal(this.symbol, ltp, raw, forcedAnchor);
  }
  onSignal(type: "BUY_SIGNAL" | "SELL_SIGNAL", ltp?: number, reason?: string, raw?: unknown) {
    const px = ltp ?? nowLtp(this.symbol) ?? 0;
    if (type === "BUY_SIGNAL") handleBuySignal(this.symbol, px, raw);
    else handleSellSignal(this.symbol, px, reason, raw);
  }
}
