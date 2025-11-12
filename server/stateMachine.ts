/* eslint-disable no-console */

//
// State Machine for per-symbol trading windows
// Variant: Sell-Start Anchor + SELL-window breakout behavior
//
// NEW rules implemented:
//
// FLAT + SELL:
//   - Start 60s SELL window; breakout trigger @ (sellLtp + 0.5).
//   - If breakout triggers → cancel SELL window; start BUY window immediately
//     with savedBUYLTP = sellLtp + 0.5 (forced anchor).
//
// IN POSITION + SELL:
//   - Start 60s SELL window; breakout trigger @ (sellLtp + 0.5).
//   - If breakout triggers → exit full position (no-flip), then do nothing else
//     for the remainder of this SELL window.
//   - When SELL window ends → start BUY window with savedBUYLTP = sellLtp.
//
// Preserved behavior:
//   - Sell-Start anchor is captured on the first BUY signal after a SELL window.
//   - On SELL→BUY rollover (timeout), if no forced anchor is specified and no Sell-Start
//     anchor captured, first BUY window uses rollover LTP.
//   - During subsequent BUY windows after a SELL, if price < Sell-Start anchor,
//     silence current BUY window and start a fresh BUY window.
//   - Immediate BUY entry rule: if flat at BUY window start, place LIMIT @ LTP + 0.5.
//   - No-flip exit semantics always exit the full current open qty when exiting.
//

import {
  getOpenQty,
  computeQtyFromPnLContext,
  placeLimitBuy,
  placeLimitSell,
  roundPrice,
} from "./fyersClient";
import { onSymbolTick, nowLtp } from "./dataSocket";
import { isMarketOpenNow } from "./marketHours";

// ---- Types ------------------------------------------------------------------

export type Side = "BUY" | "SELL";
export type MachineState = "IDLE" | "IN_BUY_WINDOW" | "IN_SELL_WINDOW";

export interface Signal {
  type: "BUY_SIGNAL" | "SELL_SIGNAL";
  ltp: number;
  ts: number; // epoch ms
  reason?: string; // e.g., "EXIT_ONLY"
  raw?: unknown;
}

type TimerHandle = ReturnType<typeof setTimeout> | null;

// ---- Logging helpers --------------------------------------------------------

function fmtPx(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toFixed(2);
}
function fmtTs(ts: number) {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}
function log(sym: string, msg: string) {
  const t = new Date();
  const hhmmss = t.toTimeString().slice(0, 8);
  console.log(`[${hhmmss}] [${sym}] ${msg}`);
}
function debug(sym: string, msg: string) {
  console.log(`[${fmtTs(Date.now())}] [${sym}] ${msg}`);
}

// ---- Anchor state for Sell-Start variant -----------------------------------

type PerSymbolAnchorState = {
  sellStartBuyAnchor: number | null;
  savedBUYLTP: number | null;
  pendingBuyAfterSell: boolean;
  buyWindowIdxSinceSell: number;
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

// ---- Machine per symbol -----------------------------------------------------

class SymbolMachine {
  readonly sym: string;
  state: MachineState = "IDLE";

  private sellWindowTimer: TimerHandle = null;
  private buyWindowTimer: TimerHandle = null;

  private buyWindowSilenced = false;

  // SELL-window tracking & breakout context
  private sellWindowActive = false;
  private sellWindowDoNothing = false; // if true, ignore actions until SELL window end
  private sellWindowStartLtp: number | null = null; // LTP at SELL signal
  private sellWindowBreakoutPx: number | null = null; // sellLtp + 0.5
  private hadPositionOnSell: boolean = false; // whether a position existed at SELL signal
  private breakoutTriggeredInPos: boolean = false; // IN-POS breakout occurred

  constructor(sym: string) {
    this.sym = sym;
    log(this.sym, "[INIT] StateMachine created");
  }

  handleSignal(sig: Signal) {
    if (!isMarketOpenNow()) {
      debug(this.sym, "[SKIP] market closed, ignoring signal");
      return;
    }
    if (sig.type === "SELL_SIGNAL") {
      this.onSellSignal(sig);
    } else if (sig.type === "BUY_SIGNAL") {
      this.onBuySignal(sig);
    }
  }

  // ---- SELL handling --------------------------------------------------------

  private onSellSignal(sig: Signal) {
    const openQty = getOpenQty(this.sym);
    const hadPos = openQty > 0;

    log(this.sym, `Signal: SELL_SIGNAL @ LTP=${fmtPx(sig.ltp)} | state=${this.state}`);

    // Start SELL window; arm breakout watcher @ (sellLtp + 0.5)
    this.startSellWindow(sig.ltp, 60_000, sig.reason ?? "GENERIC", hadPos);
  }

  private startSellWindow(ltpAtStart: number, windowMs: number, reason: string, hadPos: boolean) {
    const a = ensureAnchor(this.sym);
    this.clearTimers();

    a.pendingBuyAfterSell = true;
    a.buyWindowIdxSinceSell = 0;
    a.lastSellReason = reason;

    this.state = "IN_SELL_WINDOW";
    this.sellWindowActive = true;
    this.sellWindowDoNothing = false;
    this.hadPositionOnSell = hadPos;
    this.breakoutTriggeredInPos = false;
    this.sellWindowStartLtp = ltpAtStart;
    this.sellWindowBreakoutPx = roundPrice(ltpAtStart + 0.5);

    const untilTs = Date.now() + windowMs;
    log(
      this.sym,
      `[SELL WINDOW] start 60s until ${fmtTs(untilTs)} | anchor=${fmtPx(
        ltpAtStart
      )} (BUY deferred to end) | breakout>${fmtPx(this.sellWindowBreakoutPx)}`
    );

    // Arm breakout watcher: if LTP > (sellLtp + 0.5)
    onSymbolTick(this.sym, (tickLtp: number) => {
      if (!this.sellWindowActive) return;
      if (this.sellWindowDoNothing) return; // already acted in this SELL window

      const breakoutPx = this.sellWindowBreakoutPx!;
      if (tickLtp > breakoutPx) {
        if (this.hadPositionOnSell) {
          // IN-POS: exit entire position and do nothing else until window end
          const q = getOpenQty(this.sym);
          if (q > 0) {
            const px = roundPrice(tickLtp - 0.5);
            debug(
              this.sym,
              `[SELL BREAKOUT] tick=${fmtPx(tickLtp)} > ${fmtPx(
                breakoutPx
              )} → EXIT qty=${q} @ LIMIT=${fmtPx(px)} and silence until window end`
            );
            placeLimitSell(this.sym, q, px, { tag: "SELL_BREAKOUT_EXIT" });
          } else {
            debug(this.sym, `[SELL BREAKOUT] triggered but no open qty at execution time`);
          }
          this.breakoutTriggeredInPos = true;
          this.sellWindowDoNothing = true;
        } else {
          // FLAT: cancel SELL window and start BUY window with forced anchor = sellLtp + 0.5
          const forcedAnchor = breakoutPx; // equals sellLtp + 0.5 (already rounded)
          debug(
            this.sym,
            `[SELL BREAKOUT] tick=${fmtPx(
              tickLtp
            )} > ${fmtPx(breakoutPx)} while FLAT → cancel SELL window, start BUY window (savedBUYLTP=${fmtPx(
              forcedAnchor
            )})`
          );
          this.cancelSellWindowTimerOnly();
          this.sellWindowActive = false;
          this.startBuyWindow(tickLtp, 60_000, forcedAnchor);
        }
      }
    });

    // SELL window end → rollover
    this.sellWindowTimer = setTimeout(() => {
      this.sellWindowTimer = null;
      this.sellWindowActive = false;
      log(this.sym, `[WINDOW END] SELL window ended`);
      this.onSellWindowEnded();
    }, windowMs);
  }

  private onSellWindowEnded() {
    const a = ensureAnchor(this.sym);
    const ltpNow = nowLtp(this.sym) ?? 0;

    // If we were IN-POS and breakout already exited us, we now start a BUY window
    // with savedBUYLTP = sellLtp (the SELL signal's LTP).
    if (this.breakoutTriggeredInPos && this.sellWindowStartLtp != null) {
      const forcedAnchor = this.sellWindowStartLtp;
      debug(
        this.sym,
        `[SELL END] breakout-in-pos path → start BUY window with savedBUYLTP=${fmtPx(forcedAnchor)}`
      );
      this.startBuyWindow(ltpNow, 60_000, forcedAnchor);
      return;
    }

    // Otherwise, normal rollover (no forced anchor): follow prior rules
    this.startBuyWindow(ltpNow, 60_000);
  }

  // ---- BUY handling ---------------------------------------------------------

  private onBuySignal(sig: Signal) {
    const a = ensureAnchor(this.sym);

    log(this.sym, `Signal: BUY_SIGNAL @ LTP=${fmtPx(sig.ltp)} | state=${this.state}`);

    // Capture Sell-Start anchor once (first BUY signal after a SELL window)
    if (a.pendingBuyAfterSell) {
      a.sellStartBuyAnchor = sig.ltp;
      a.pendingBuyAfterSell = false;
      debug(
        this.sym,
        `[ANCHOR] captured sellStartBuyAnchor=${fmtPx(sig.ltp)} (first BUY signal after SELL)`
      );
    }

    if (this.state === "IDLE") {
      this.startBuyWindow(sig.ltp, 60_000);
    }
  }

  /**
   * Starts a BUY window.
   * @param nowLtpPx last known LTP to use if needed
   * @param windowMs window length
   * @param forcedAnchor if provided, overrides the computed anchor and sets savedBUYLTP to this value
   */
  private startBuyWindow(nowLtpPx: number, windowMs: number, forcedAnchor?: number) {
    const a = ensureAnchor(this.sym);
    this.clearTimers();

    // Determine anchor:
    // - forcedAnchor takes precedence (used for the two SELL-window cases you specified)
    // - else Sell-Start anchor (if captured)
    // - else rollover LTP
    const computedAnchor = forcedAnchor ?? a.sellStartBuyAnchor ?? nowLtpPx;

    a.savedBUYLTP = computedAnchor;
    a.buyWindowIdxSinceSell += 1;

    this.state = "IN_BUY_WINDOW";
    this.buyWindowSilenced = false;

    const untilTs = Date.now() + windowMs;
    log(
      this.sym,
      `[BUY WINDOW] start 60s (idx=${a.buyWindowIdxSinceSell}) until ${fmtTs(
        untilTs
      )} | savedBUYLTP=${fmtPx(computedAnchor)}${forcedAnchor != null ? " (forced)" : ""}`
    );

    // Immediate entry if flat
    const openQty = getOpenQty(this.sym);
    const allowImmediate = true;
    if (openQty === 0 && allowImmediate) {
      const ltp = nowLtp(this.sym) ?? nowLtpPx;
      const limitPx = roundPrice(ltp + 0.5);
      const qty = computeQtyFromPnLContext(this.sym);
      log(
        this.sym,
        `[ENTER LONG] window=BUY nextFill=1 qty=${qty}, LIMIT=${fmtPx(limitPx)}, LTP=${fmtPx(ltp)}`
      );
      placeLimitBuy(this.sym, qty, limitPx, { tag: "BUY_WINDOW_IMMEDIATE" });
    }

    this.armBuyWindowGuards(computedAnchor, untilTs);
  }

  private armBuyWindowGuards(sellStartAnchor: number, untilTs: number) {
    const a = ensureAnchor(this.sym);

    onSymbolTick(this.sym, (tickLtp: number) => {
      if (this.state !== "IN_BUY_WINDOW") return;
      if (this.buyWindowSilenced) return;

      if (a.buyWindowIdxSinceSell > 1 && tickLtp < sellStartAnchor) {
        debug(
          this.sym,
          `[BUY WINDOW] price fell below sellStartBuyAnchor=${fmtPx(
            sellStartAnchor
          )} → silencing & restarting new BUY window`
        );
        a.savedBUYLTP = sellStartAnchor;
        this.buyWindowSilenced = true;

        this.startBuyWindow(tickLtp, 60_000);
      }
    });

    this.buyWindowTimer = setTimeout(() => {
      this.buyWindowTimer = null;
      if (!this.buyWindowSilenced) {
        log(this.sym, `[WINDOW END] BUY window ended`);
      }
      this.state = "IDLE";
    }, Math.max(0, untilTs - Date.now()));
  }

  private cancelSellWindowTimerOnly() {
    if (this.sellWindowTimer) {
      clearTimeout(this.sellWindowTimer);
      this.sellWindowTimer = null;
    }
  }

  private clearTimers() {
    if (this.sellWindowTimer) {
      clearTimeout(this.sellWindowTimer);
      this.sellWindowTimer = null;
    }
    if (this.buyWindowTimer) {
      clearTimeout(this.buyWindowTimer);
      this.buyWindowTimer = null;
    }
    // Reset SELL-window flags (next window will set them again)
    this.sellWindowActive = false;
    this.sellWindowDoNothing = false;
    this.sellWindowStartLtp = null;
    this.sellWindowBreakoutPx = null;
    this.hadPositionOnSell = false;
    this.breakoutTriggeredInPos = false;
  }
}

// ---- Registry & exports -----------------------------------------------------

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
export function handleBuySignal(sym: string, ltp: number, raw?: unknown) {
  getMachine(sym).handleSignal({ type: "BUY_SIGNAL", ltp, ts: Date.now(), raw });
}

/**
 * Compatibility class for legacy imports in webhookHandler:
 * - Accepts either a `symbol: string` OR a config object:
 *     { symbol, underlying?, orderValue?, slPoints? }
 * - Provides `onSignal("BUY_SIGNAL"|"SELL_SIGNAL")` in addition to .buy/.sell
 */
type LegacyCtorArg =
  | string
  | {
      symbol: string;
      underlying?: string;
      orderValue?: number;
      slPoints?: number;
    };

export class TradeStateMachine {
  public readonly symbol: string;
  public readonly underlying?: string;
  public readonly orderValue?: number;
  public readonly slPoints?: number;

  constructor(arg: LegacyCtorArg) {
    if (typeof arg === "string") {
      this.symbol = arg;
    } else {
      this.symbol = arg.symbol;
      this.underlying = arg.underlying;
      this.orderValue = arg.orderValue;
      this.slPoints = arg.slPoints;
    }
    // ensure underlying machine exists
    getMachine(this.symbol);
  }

  /** Legacy helpers */
  sell(ltp: number, reason?: string, raw?: unknown) {
    handleSellSignal(this.symbol, ltp, reason, raw);
  }
  buy(ltp: number, raw?: unknown) {
    handleBuySignal(this.symbol, ltp, raw);
  }

  /** webhookHandler uses this */
  onSignal(type: "BUY_SIGNAL" | "SELL_SIGNAL", ltp?: number, reason?: string, raw?: unknown) {
    const px = ltp ?? nowLtp(this.symbol) ?? 0;
    if (type === "BUY_SIGNAL") {
      handleBuySignal(this.symbol, px, raw);
    } else {
      handleSellSignal(this.symbol, px, reason, raw);
    }
  }

  // Generic handler (kept for completeness)
  handle(signal: Signal) {
    getMachine(this.symbol).handleSignal(signal);
  }
}
