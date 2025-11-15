/* eslint-disable no-console */

/**
 * server/stateMachine.ts
 *
 * Core per-symbol state machine implementing your logic:
 *
 * States:
 *   - WAIT_FOR_SIGNAL: waiting for first BUY (or SELL just for anchors)
 *   - ENTRY_WINDOW   : 60s window after a new BUY; either small loss or survive
 *   - PROFIT_WINDOW  : 60s rolling windows managing a profitable position
 *   - WAIT_WINDOW    : flat, waiting for next BUY condition (after SELL or loss)
 *
 * Signals (fed from webhookHandler.ts):
 *   - BUY_SIGNAL
 *   - SELL_SIGNAL
 *
 * This file is intentionally heavy on comments + logs so you can
 * debug behavior tick-by-tick from console output.
 */

// ---------------------------------------------------------------------------
// Imports from your existing modules
// ---------------------------------------------------------------------------

import {
  getOpenQty,
  computeQtyFromPnLContext,
  placeLimitBuy,
  placeLimitSell,
  roundPrice,
} from "./fyersClient";
import { onSymbolTick, nowLtp } from "./dataSocket";
import { isMarketOpenNow } from "./marketHours";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MachineState =
  | "WAIT_FOR_SIGNAL"
  | "ENTRY_WINDOW"
  | "PROFIT_WINDOW"
  | "WAIT_WINDOW";

export interface Signal {
  type: "BUY_SIGNAL" | "SELL_SIGNAL";
  ltp: number;
  raw?: unknown;
}

type TimerHandle = NodeJS.Timeout | null;

/**
 * Anchor & mode data kept per symbol.
 * Mirrors your naming:
 *   - savedBuyLtp        → savedBUYLTP
 *   - lastsavedBuyLTP    → savedLastBUYLTP
 *   - savedSellLtp       → savedSellLTP
 *   - waitMode           → afterSell / afterBuy
 */
interface PerSymbolAnchorState {
  savedBUYLTP: number | null;
  savedLastBUYLTP: number | null;
  savedSellLTP: number | null;

  // WAIT_WINDOW behavior:
  // - "afterSell": we just ended a PROFIT cycle, wait for deeper retrace
  // - "afterBuy" : we just ended a LOSS / non-profit cycle, wait for breakout
  waitMode: "afterSell" | "afterBuy" | null;

  // For logging / debugging only
  lastSellReason: string | null;
}

// per-symbol anchor store
const ANCHOR: Record<string, PerSymbolAnchorState> = {};

/** Ensure we always have an anchor object for a symbol. */
function ensureAnchor(sym: string): PerSymbolAnchorState {
  if (!ANCHOR[sym]) {
    ANCHOR[sym] = {
      savedBUYLTP: null,
      savedLastBUYLTP: null,
      savedSellLTP: null,
      waitMode: null,
      lastSellReason: null,
    };
  }
  return ANCHOR[sym];
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

function fmtTs(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}

function fmtPx(px: number | null | undefined): string {
  if (px == null || Number.isNaN(px)) return "NA";
  return px.toFixed(2);
}

function log(sym: string, msg: string) {
  console.log(`[${fmtTs(Date.now())}] [${sym}] ${msg}`);
}

function debug(sym: string, msg: string) {
  console.log(`[${fmtTs(Date.now())}] [${sym}] ${msg}`);
}

// All windows are 60 seconds
const WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// SymbolMachine – one instance per Fyers symbol
// ---------------------------------------------------------------------------

class SymbolMachine {
  readonly sym: string;

  /** High-level state: WAIT_FOR_SIGNAL → ENTRY_WINDOW → PROFIT_WINDOW → WAIT_WINDOW */
  state: MachineState = "WAIT_FOR_SIGNAL";

  /** 60s window timer */
  private windowTimer: TimerHandle = null;

  /** unsubscribe function from onSymbolTick() */
  private tickUnsub: (() => void) | null = null;

  /** incrementing ID to distinguish old vs current window callbacks */
  private windowId = 0;

  /** what kind of window is active (for sanity checks/logs) */
  private windowKind: "ENTRY" | "PROFIT" | "WAIT" | null = null;

  /** absolute timestamp when current window ends (ms) */
  private windowEndsAt: number | null = null;

  /** true if we exited position with loss in the current 60s window */
  private exitedThisWindow = false;

  /** true if we booked profit via SELL in the current 60s window */
  private soldForProfitThisWindow = false;

  constructor(sym: string) {
    this.sym = sym;
    log(sym, "[INIT] machine created, state=WAIT_FOR_SIGNAL");
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Clear current 60s window (timer + tick subscription).
   * Called whenever we start a new window or a state transition ends one.
   */
  private clearWindow() {
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    if (this.tickUnsub) {
      try {
        this.tickUnsub();
      } catch (err) {
        console.error(`[${this.sym}] error during tickUnsub:`, err);
      }
      this.tickUnsub = null;
    }
    this.windowKind = null;
    this.windowEndsAt = null;
  }

  /** Safe wrapper around getOpenQty; logs errors once if any. */
  private getOpenQtySafe(): number {
    try {
      return getOpenQty(this.sym) ?? 0;
    } catch (err) {
      console.error(`[${this.sym}] getOpenQty error:`, err);
      return 0;
    }
  }

  /** Convenience: true if we currently hold a long position on this symbol. */
  private isInPosition(): boolean {
    return this.getOpenQtySafe() > 0;
  }

  // -------------------------------------------------------------------------
  // Public entry: signals from webhookHandler.ts
  // -------------------------------------------------------------------------

  /**
   * Generic signal handler – all BUY/SELL signals come here.
   * It routes to onBuySignal / onSellSignal based on sig.type.
   */
  handleSignal(sig: Signal) {
    if (!isMarketOpenNow()) {
      debug(
        this.sym,
        `[IGNORE] Market closed, ignoring signal ${sig.type} @ LTP=${fmtPx(
          sig.ltp
        )}`
      );
      return;
    }

    if (sig.type === "BUY_SIGNAL") {
      this.onBuySignal(sig);
    } else {
      this.onSellSignal(sig);
    }
  }

  // -------------------------------------------------------------------------
  // BUY / SELL signal logic
  // -------------------------------------------------------------------------

  /**
   * BUY SIGNAL:
   * - Only actively used in:
   *     * WAIT_FOR_SIGNAL – normal first entry
   *     * WAIT_WINDOW     – re-entry after SELL or LOSS (based on waitMode)
   * - Behavior:
   *     savedBUYLTP = LTP
   *     savedLastBUYLTP = LTP
   *     place BUY (anchor + 0.5)
   *     start ENTRY_WINDOW (A)
   */
  private onBuySignal(sig: Signal) {
    const { ltp } = sig;
    const a = ensureAnchor(this.sym);
    const anchor = ltp;

    // In ENTRY_WINDOW / PROFIT_WINDOW we *ignore* direct BUY signals,
    // because the FSM already controls behavior from there.
    if (this.state !== "WAIT_FOR_SIGNAL" && this.state !== "WAIT_WINDOW") {
      debug(
        this.sym,
        `[BUY_SIGNAL] state=${this.state} → ignoring BUY (ltp=${fmtPx(ltp)})`
      );
      return;
    }

    // Update anchors
    a.savedBUYLTP = anchor;
    a.savedLastBUYLTP = anchor;

    log(
      this.sym,
      `[BUY_SIGNAL] anchor=${fmtPx(anchor)} prevLastBuy=${fmtPx(
        a.savedLastBUYLTP
      )} waitMode=${a.waitMode ?? "NA"}`
    );

    // Compute qty from your P&L context and place entry BUY
    const qty = computeQtyFromPnLContext(this.sym);
    const buyPrice = roundPrice(anchor + 0.5); // "anchor + 0.5" rule

    debug(
      this.sym,
      `[ENTRY] Placing BUY qty=${qty} @ ${fmtPx(
        buyPrice
      )} (anchor=${fmtPx(anchor)}) [tag=ENTRY_SIGNAL_BUY]`
    );
    placeLimitBuy(this.sym, qty, buyPrice, { tag: "ENTRY_SIGNAL_BUY" });

    // Transition into ENTRY_WINDOW FSM
    this.startEntryWindow("from BUY_SIGNAL");
  }

  /**
   * SELL SIGNAL:
   * - In PROFIT_WINDOW:
   *     → treat as "take profit":
   *         savedSellLTP = LTP
   *         savedLastBUYLTP = savedBUYLTP
   *         exit position
   *         soldForProfitThisWindow = true
   * - In other states:
   *     → we just store anchors; no immediate trade.
   */
  private onSellSignal(sig: Signal) {
    const { ltp } = sig;
    const a = ensureAnchor(this.sym);

    log(
      this.sym,
      `[SELL_SIGNAL] received in state=${this.state} @ LTP=${fmtPx(ltp)}`
    );

    if (this.state === "PROFIT_WINDOW") {
      // BOOK PROFIT in PROFIT_WINDOW
      const qty = this.getOpenQtySafe();
      if (qty > 0) {
        a.savedSellLTP = ltp;
        a.savedLastBUYLTP = a.savedBUYLTP ?? a.savedLastBUYLTP;

        const sellPx = roundPrice(ltp - 0.5); // cushion below LTP
        log(
          this.sym,
          `[PROFIT_WINDOW] SELL_SIGNAL: booking PROFIT qty=${qty} @ ${fmtPx(
            sellPx
          )} (ltp=${fmtPx(
            ltp
          )}) → savedSellLTP=${fmtPx(a.savedSellLTP)} [tag=PROFIT_SELL]`
        );
        placeLimitSell(this.sym, qty, sellPx, { tag: "PROFIT_SELL" });

        this.soldForProfitThisWindow = true;
      } else {
        debug(
          this.sym,
          `[PROFIT_WINDOW] SELL_SIGNAL but qty=0 → no position to close`
        );
      }
      // The window expiry will move us to WAIT_WINDOW with waitMode="afterSell".
      return;
    }

    // In non-PROFIT_WINDOW states, we only update anchors for future Waitwindow use.
    a.savedSellLTP = ltp;
    a.savedLastBUYLTP = a.savedBUYLTP ?? a.savedLastBUYLTP;

    debug(
      this.sym,
      `[SELL_SIGNAL] (non-PROFIT_WINDOW) stored savedSellLTP=${fmtPx(
        a.savedSellLTP
      )}, savedLastBUYLTP=${fmtPx(a.savedLastBUYLTP)}; state=${this.state}`
    );
  }

  // -------------------------------------------------------------------------
  // ENTRY_WINDOW (A)
// ---------------------------------------------------------------------------

  /**
   * ENTRY_WINDOW:
   * - Starts immediately after placing a BUY.
   * - 60s duration.
   * - Inside window:
   *     * If LTP <= savedBUYLTP - 0.5 and we still hold position:
   *         → exit with ~0.5 loss, mark exitedThisWindow.
   *     * Otherwise → just HOLD (no scaling).
   * - At window end:
   *     * If still in position → PROFIT_WINDOW
   *     * Else (flat) → WAIT_WINDOW with waitMode="afterBuy"
   */
  private startEntryWindow(reason: string) {
    this.clearWindow();
    this.state = "ENTRY_WINDOW";
    this.windowKind = "ENTRY";
    this.exitedThisWindow = false;
    this.soldForProfitThisWindow = false;

    const a = ensureAnchor(this.sym);
    const anchor = a.savedBUYLTP;

    this.windowId += 1;
    const myId = this.windowId;
    this.windowEndsAt = Date.now() + WINDOW_MS;

    log(
      this.sym,
      `[ENTRY_WINDOW] START (${reason}) id=${myId} ` +
        `anchor(savedBUYLTP)=${fmtPx(anchor)} endsAt=${fmtTs(
          this.windowEndsAt
        )}`
    );

    // Subscribe to ticks
    this.tickUnsub = onSymbolTick(this.sym, (ltp) => {
      if (this.windowId !== myId || this.windowKind !== "ENTRY") return;
      this.handleEntryTick(ltp);
    });

    // Timer for window end
    this.windowTimer = setTimeout(() => {
      if (this.windowId !== myId || this.windowKind !== "ENTRY") return;
      this.onEntryWindowEnd();
    }, WINDOW_MS);
  }

  /** Tick handler for ENTRY_WINDOW. */
  private handleEntryTick(ltp: number) {
    const a = ensureAnchor(this.sym);
    const anchor = a.savedBUYLTP;

    debug(
      this.sym,
      `[ENTRY_WINDOW:TICK] LTP=${fmtPx(ltp)} anchor=${fmtPx(
        anchor
      )} inPos=${this.isInPosition()}`
    );

    if (anchor == null) {
      debug(
        this.sym,
        "[ENTRY_WINDOW:TICK] anchor is null → ignoring tick (should not happen)"
      );
      return;
    }

    // Stop-out condition: price <= anchor - 0.5 and we still have a position.
    if (this.isInPosition() && ltp <= anchor - 0.5 && !this.exitedThisWindow) {
      const qty = this.getOpenQtySafe();
      const exitPx = roundPrice(ltp - 0.5);

      log(
        this.sym,
        `[ENTRY_WINDOW:STOP_OUT] LTP=${fmtPx(
          ltp
        )} <= anchor-0.5=${fmtPx(anchor - 0.5)} → EXIT qty=${qty} @ ${fmtPx(
          exitPx
        )} [tag=ENTRY_STOP_LOSS]`
      );
      if (qty > 0) {
        placeLimitSell(this.sym, qty, exitPx, { tag: "ENTRY_STOP_LOSS" });
      }
      this.exitedThisWindow = true;
      // Do nothing else in this window; we allow timer to expire naturally.
      return;
    }

    // Otherwise: HOLD. (No extra logs to avoid spam.)
  }

  /** ENTRY_WINDOW end-of-60s handler. */
  private onEntryWindowEnd() {
    this.clearWindow();
    const a = ensureAnchor(this.sym);
    const inPos = this.isInPosition();
    const ltp = nowLtp(this.sym);

    log(
      this.sym,
      `[ENTRY_WINDOW] END inPos=${inPos} exitedThisWindow=${
        this.exitedThisWindow
      } savedBUYLTP=${fmtPx(a.savedBUYLTP)} lastLTP=${fmtPx(ltp)}`
    );

    if (inPos) {
      // Survived entry window → become PROFIT_WINDOW
      log(this.sym, "[STATE_CHANGE] ENTRY_WINDOW → PROFIT_WINDOW");
      this.startProfitWindow("entry survived");
    } else {
      // Flat: most likely we hit the ~0.5 loss.
      a.waitMode = "afterBuy";
      log(
        this.sym,
        "[STATE_CHANGE] ENTRY_WINDOW → WAIT_WINDOW (flat, after loss). waitMode=afterBuy"
      );
      this.startWaitWindow("after ENTRY loss/flat");
    }
  }

  // -------------------------------------------------------------------------
  // PROFIT_WINDOW
  // -------------------------------------------------------------------------

  /**
   * PROFIT_WINDOW:
   * - We reached here with an open position and no loss in ENTRY_WINDOW.
   * - 60s duration, can loop multiple times.
   * - Inside window:
   *     * If LTP <= anchor - 0.5 → exit with loss (exitedThisWindow=true).
   *     * If SELL_SIGNAL (via onSellSignal) → book profit, soldForProfitThisWindow=true.
   *     * Else → remain in profit (hold).
   * - At window end:
   *     * If remainInProfit (still in position, no loss, no sell):
   *         → start another PROFIT_WINDOW.
   *     * Else (flat due to loss or profit):
   *         → WAIT_WINDOW with:
   *             waitMode="afterSell" if soldForProfitThisWindow
   *             waitMode="afterBuy"  if loss
   */
  private startProfitWindow(reason: string) {
    this.clearWindow();
    this.state = "PROFIT_WINDOW";
    this.windowKind = "PROFIT";
    this.exitedThisWindow = false;
    this.soldForProfitThisWindow = false;

    const a = ensureAnchor(this.sym);

    this.windowId += 1;
    const myId = this.windowId;
    this.windowEndsAt = Date.now() + WINDOW_MS;

    log(
      this.sym,
      `[PROFIT_WINDOW] START (${reason}) id=${myId} ` +
        `anchor(savedBUYLTP)=${fmtPx(a.savedBUYLTP)} endsAt=${fmtTs(
          this.windowEndsAt
        )}`
    );

    this.tickUnsub = onSymbolTick(this.sym, (ltp) => {
      if (this.windowId !== myId || this.windowKind !== "PROFIT") return;
      this.handleProfitTick(ltp);
    });

    this.windowTimer = setTimeout(() => {
      if (this.windowId !== myId || this.windowKind !== "PROFIT") return;
      this.onProfitWindowEnd();
    }, WINDOW_MS);
  }

  /** Tick handler for PROFIT_WINDOW. */
  private handleProfitTick(ltp: number) {
    const a = ensureAnchor(this.sym);
    const anchor = a.savedBUYLTP;

    debug(
      this.sym,
      `[PROFIT_WINDOW:TICK] LTP=${fmtPx(ltp)} anchor=${fmtPx(
        anchor
      )} inPos=${this.isInPosition()} exited=${this.exitedThisWindow} soldForProfit=${this.soldForProfitThisWindow}`
    );

    if (anchor == null) {
      debug(
        this.sym,
        "[PROFIT_WINDOW:TICK] anchor is null → ignoring tick (should not happen)"
      );
      return;
    }

    // If we already exited or booked profit in this window, ignore further ticks.
    if (this.exitedThisWindow || this.soldForProfitThisWindow) {
      return;
    }

    // Loss condition: full reversal below anchor - 0.5
    if (this.isInPosition() && ltp <= anchor - 0.5) {
      const qty = this.getOpenQtySafe();
      const exitPx = roundPrice(ltp - 0.5);

      log(
        this.sym,
        `[PROFIT_WINDOW:STOP_OUT] LTP=${fmtPx(
          ltp
        )} <= anchor-0.5=${fmtPx(anchor - 0.5)} → EXIT qty=${qty} @ ${fmtPx(
          exitPx
        )} [tag=PROFIT_STOP_LOSS]`
      );
      if (qty > 0) {
        placeLimitSell(this.sym, qty, exitPx, { tag: "PROFIT_STOP_LOSS" });
      }
      this.exitedThisWindow = true;
      return;
    }

    // Else: remain in profit; no action required.
  }

  /** PROFIT_WINDOW end-of-60s handler. */
  private onProfitWindowEnd() {
    this.clearWindow();
    const a = ensureAnchor(this.sym);
    const inPos = this.isInPosition();
    const ltp = nowLtp(this.sym);

    const remainInProfit =
      inPos && !this.exitedThisWindow && !this.soldForProfitThisWindow;

    log(
      this.sym,
      `[PROFIT_WINDOW] END inPos=${inPos} remainInProfit=${remainInProfit} ` +
        `exitedThisWindow=${this.exitedThisWindow} soldForProfit=${this.soldForProfitThisWindow} ` +
        `anchor(savedBUYLTP)=${fmtPx(a.savedBUYLTP)} lastLTP=${fmtPx(ltp)}`
    );

    if (remainInProfit) {
      // Still in a clean profitable position: loop another PROFIT_WINDOW.
      log(
        this.sym,
        "[STATE_STAY] PROFIT_WINDOW → PROFIT_WINDOW (still in healthy profit)"
      );
      this.startProfitWindow("loop continue");
      return;
    }

    // Position is flat (loss or profit). Move to WAIT_WINDOW with appropriate mode.
    this.state = "WAIT_WINDOW";

    if (this.soldForProfitThisWindow) {
      // Just finished a profitable SELL
      a.waitMode = "afterSell";
      log(
        this.sym,
        `[STATE_CHANGE] PROFIT_WINDOW → WAIT_WINDOW (after PROFIT sell) waitMode=afterSell ` +
          `savedSellLTP=${fmtPx(a.savedSellLTP)} savedLastBUYLTP=${fmtPx(
            a.savedLastBUYLTP
          )}`
      );
    } else {
      // Loss / non-profit exit
      a.waitMode = "afterBuy";
      log(
        this.sym,
        "[STATE_CHANGE] PROFIT_WINDOW → WAIT_WINDOW (after LOSS) waitMode=afterBuy"
      );
    }

    this.startWaitWindow("after PROFIT_WINDOW");
  }

  // -------------------------------------------------------------------------
  // WAIT_WINDOW
  // -------------------------------------------------------------------------

  /**
   * WAIT_WINDOW:
   * - We are FLAT and waiting for the next BUY condition.
   * - Two modes:
   *   * afterSell:
   *       - from a PROFIT cycle (a profitable SELL)
   *       - condition: LTP < savedLastBUYLTP (deeper retrace below last buy)
   *   * afterBuy:
   *       - from a LOSS / non-profitable exit
   *       - condition: LTP > savedBUYLTP (breakout above buy anchor)
   * - 60s window repeats until one of these triggers.
   */
  private startWaitWindow(reason: string) {
    this.clearWindow();
    this.state = "WAIT_WINDOW";
    this.windowKind = "WAIT";
    this.exitedThisWindow = false;
    this.soldForProfitThisWindow = false;

    const a = ensureAnchor(this.sym);

    this.windowId += 1;
    const myId = this.windowId;
    this.windowEndsAt = Date.now() + WINDOW_MS;

    log(
      this.sym,
      `[WAIT_WINDOW] START (${reason}) id=${myId} mode=${a.waitMode ?? "NA"} ` +
        `savedBUYLTP=${fmtPx(a.savedBUYLTP)} savedLastBUYLTP=${fmtPx(
          a.savedLastBUYLTP
        )} savedSellLTP=${fmtPx(a.savedSellLTP)} endsAt=${fmtTs(
          this.windowEndsAt
        )}`
    );

    // Tick handler for WAIT_WINDOW
    this.tickUnsub = onSymbolTick(this.sym, (ltp) => {
      if (this.windowId !== myId || this.windowKind !== "WAIT") return;
      this.handleWaitTick(ltp);
    });

    this.windowTimer = setTimeout(() => {
      if (this.windowId !== myId || this.windowKind !== "WAIT") return;
      this.onWaitWindowEnd();
    }, WINDOW_MS);
  }

  /** Tick handler for WAIT_WINDOW. */
  private handleWaitTick(ltp: number) {
    const a = ensureAnchor(this.sym);
    const mode = a.waitMode ?? "afterBuy"; // default fallback

    debug(
      this.sym,
      `[WAIT_WINDOW:TICK] mode=${mode} LTP=${fmtPx(
        ltp
      )} savedBUYLTP=${fmtPx(a.savedBUYLTP)} savedLastBUYLTP=${fmtPx(
        a.savedLastBUYLTP
      )}`
    );

    if (mode === "afterSell") {
      // After PROFIT SELL: wait for deeper retrace below lastSavedBUYLTP
      const ref = a.savedLastBUYLTP;
      if (ref == null) {
        debug(
          this.sym,
          "[WAIT_WINDOW:TICK] afterSell but savedLastBUYLTP=null → nothing to do"
        );
        return;
      }

      if (ltp < ref) {
        // Condition met: LTP < lastSavedBUYLTP
        a.savedBUYLTP = ref;
        log(
          this.sym,
          `[WAIT_WINDOW:TRIGGER_AFTER_SELL] LTP=${fmtPx(
            ltp
          )} < lastSavedBUYLTP=${fmtPx(
            ref
          )} → set savedBUYLTP=${fmtPx(ref)} and BUY`
        );

        this.triggerWaitWindowBuy(ref, "afterSell retrace");
      }
    } else {
      // afterBuy: wait for breakout above savedBUYLTP
      const ref = a.savedBUYLTP;
      if (ref == null) {
        debug(
          this.sym,
          "[WAIT_WINDOW:TICK] afterBuy but savedBUYLTP=null → nothing to do"
        );
        return;
      }

      if (ltp > ref) {
        // Breakout above anchor
        a.savedBUYLTP = ltp;
        a.savedLastBUYLTP = ltp;
        log(
          this.sym,
          `[WAIT_WINDOW:TRIGGER_AFTER_BUY] LTP=${fmtPx(
            ltp
          )} > savedBUYLTP=${fmtPx(
            ref
          )} → update savedBUYLTP=${fmtPx(ltp)} and BUY`
        );

        this.triggerWaitWindowBuy(ltp, "afterBuy breakout");
      }
    }
  }

  /**
   * Helper to place the BUY when WAIT_WINDOW condition is triggered,
   * and then start a fresh ENTRY_WINDOW cycle.
   */
  private triggerWaitWindowBuy(anchor: number, reason: string) {
    const a = ensureAnchor(this.sym);
    a.savedBUYLTP = anchor;
    a.savedLastBUYLTP = anchor;

    const qty = computeQtyFromPnLContext(this.sym);
    const buyPrice = roundPrice(anchor + 0.5);

    log(
      this.sym,
      `[WAIT_WINDOW:BUY] reason=${reason} anchor=${fmtPx(
        anchor
      )} qty=${qty} @ ${fmtPx(buyPrice)} [tag=WAIT_REENTRY_BUY]`
    );
    placeLimitBuy(this.sym, qty, buyPrice, { tag: "WAIT_REENTRY_BUY" });

    // This implicitly ends WAIT_WINDOW and starts a new ENTRY_WINDOW (A).
    this.startEntryWindow(`from WAIT_WINDOW (${reason})`);
  }

  /** Called when WAIT_WINDOW's 60s period ends with no trigger. */
  private onWaitWindowEnd() {
    const a = ensureAnchor(this.sym);
    log(
      this.sym,
      `[WAIT_WINDOW] END no trigger, remain flat. Re-enter WAIT_WINDOW with same mode=${a.waitMode ?? "afterBuy"}`
    );
    // Remain in WAIT_WINDOW; loop another 60s watch.
    this.startWaitWindow("loop continue");
  }
}

// ---------------------------------------------------------------------------
// Machine registry & public API used by webhookHandler.ts
// ---------------------------------------------------------------------------

const MACHINES: Record<string, SymbolMachine> = {};

/** Get (or lazily create) the SymbolMachine for a given symbol. */
export function getMachine(sym: string): SymbolMachine {
  if (!MACHINES[sym]) {
    MACHINES[sym] = new SymbolMachine(sym);
  }
  return MACHINES[sym];
}

/**
 * Public wrapper to feed BUY signals into the per-symbol state machine.
 * Called from webhookHandler.ts.
 */
export function handleBuySignal(sym: string, ltp: number, raw?: unknown) {
  const m = getMachine(sym);
  const sig: Signal = { type: "BUY_SIGNAL", ltp, raw };
  m.handleSignal(sig);
}

/**
 * Public wrapper to feed SELL signals into the per-symbol state machine.
 * Called from webhookHandler.ts.
 */
export function handleSellSignal(
  sym: string,
  ltp: number,
  reason?: string,
  raw?: unknown
) {
  const m = getMachine(sym);
  const a = ensureAnchor(sym);
  if (reason) {
    a.lastSellReason = reason;
  }
  const sig: Signal = { type: "SELL_SIGNAL", ltp, raw };
  m.handleSignal(sig);
}
