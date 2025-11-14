/* eslint-disable no-console */

import {
  getOpenQty,
  computeQtyFromPnLContext,
  placeLimitBuy,
  placeLimitSell,
  roundPrice,
} from "./fyersClient";
import { onSymbolTick, nowLtp } from "./dataSocket";
import { isMarketOpenNow } from "./marketHours";

export type MachineState = "IDLE" | "IN_BUY_WINDOW" | "IN_SELL_WINDOW";

export interface Signal {
  type: "BUY_SIGNAL" | "SELL_SIGNAL";
  ltp: number;
  raw?: unknown;
}

// Timer handle helper
type TimerHandle = NodeJS.Timeout | null;

// ─────────────────────────────────────────────────────────────────────────────
// Logging helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtTs(t: number): string {
  const d = new Date(t);
  return d.toTimeString().slice(0, 8);
}

function fmtPx(px: number | null | undefined): string {
  if (px == null || Number.isNaN(px)) return "n/a";
  return px.toFixed(2);
}

function log(sym: string, msg: string) {
  console.log(`[${fmtTs(Date.now())}] [${sym}] ${msg}`);
}

function debug(sym: string, msg: string) {
  console.log(`[${fmtTs(Date.now())}] [${sym}] ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-symbol anchor state
// ─────────────────────────────────────────────────────────────────────────────

type PerSymbolAnchorState = {
  // SELL anchor: set on each SELL signal; reused for all flat SELL windows
  sellLtpAnchor: number | null;

  // Current BUY anchor used by BUY window
  savedBUYLTP: number | null;

  // Last BUY LTP reference for future windows
  savedLastBUYLTP: number | null;

  // Flag to know first BUY after SELL
  pendingBuyAfterSell: boolean;

  // BUY window index since last SELL (1,2,3,...)
  buyWindowIdxSinceSell: number;

  // Reason / meta for last SELL (optional)
  lastSellReason: string | null;
};

const ANCHOR: Record<string, PerSymbolAnchorState> = {};

function ensureAnchor(sym: string): PerSymbolAnchorState {
  if (!ANCHOR[sym]) {
    ANCHOR[sym] = {
      sellLtpAnchor: null,
      savedBUYLTP: null,
      savedLastBUYLTP: null,
      pendingBuyAfterSell: false,
      buyWindowIdxSinceSell: 0,
      lastSellReason: null,
    };
  }
  return ANCHOR[sym];
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbol-level state machine
// ─────────────────────────────────────────────────────────────────────────────

class SymbolMachine {
  readonly sym: string;
  state: MachineState = "IDLE";

  private sellWindowTimer: TimerHandle = null;
  private buyWindowTimer: TimerHandle = null;

  // SELL context
  private sellInPosExitDone = false;
  private hadPositionOnSell = false;

  // BUY context
  private buyWindowActive = false;
  private buySilenceUntil: number | null = null; // ignore BUY signals after stop-out until window end

  constructor(sym: string) {
    this.sym = sym;
    log(sym, "[INIT] StateMachine created");
  }

  handleSignal(sig: Signal) {
    if (!isMarketOpenNow()) {
      debug(this.sym, "[SKIP] market closed, ignoring signal");
      return;
    }

    if (sig.type === "SELL_SIGNAL") {
      this.onSellSignal(sig);
    } else {
      this.onBuySignal(sig);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SELL HANDLING
  // ───────────────────────────────────────────────────────────────────────────

  private onSellSignal(sig: Signal) {
    const sym = this.sym;
    const ltp = sig.ltp;
    const a = ensureAnchor(sym);

    const openQty = getOpenQty(sym);
    this.hadPositionOnSell = openQty > 0;
    this.sellInPosExitDone = false;

    a.sellLtpAnchor = ltp;
    a.pendingBuyAfterSell = true;
    a.lastSellReason = "SELL_SIGNAL";

    debug(
      sym,
      `[SELL SIGNAL] ltp=${fmtPx(
        ltp
      )} | openQty=${openQty} | hadPositionOnSell=${this.hadPositionOnSell}`
    );

    this.clearBuyOnly();

    if (openQty > 0) {
      this.startSellWindowInPosition();
    } else {
      this.startSellWindowFlat();
    }
  }

  private startSellWindowInPosition() {
    this.state = "IN_SELL_WINDOW";
    this.sellInPosExitDone = false;

    const windowMs = 60_000;
    const windowEnd = Date.now() + windowMs;

    log(
      this.sym,
      `[SELL WINDOW IN-POS] start 60s until ${fmtTs(windowEnd)} (immediate exit on first tick)`
    );

    // Timer: when it ends, we just go back to IDLE
    this.sellWindowTimer = setTimeout(() => {
      this.sellWindowTimer = null;
      this.state = "IDLE";
      log(this.sym, "[SELL WINDOW IN-POS] window ended → IDLE");
    }, windowMs);

    // On first tick: exit full qty @ (tick - 0.5)
    onSymbolTick(this.sym, (ltp: number) => {
      if (this.state !== "IN_SELL_WINDOW") return;
      if (this.sellInPosExitDone) return;

      const qty = getOpenQty(this.sym);
      if (qty <= 0) {
        debug(this.sym, "[SELL IN-POS] no open qty at tick, nothing to exit");
        this.sellInPosExitDone = true;
        return;
      }

      const px = roundPrice(ltp - 0.5);
      debug(
        this.sym,
        `[SELL IN-POS] first tick=${fmtPx(
          ltp
        )} → EXIT full qty=${qty} @ LIMIT=${fmtPx(px)}; remain in SELL window`
      );
      placeLimitSell(this.sym, qty, px, { tag: "SELL_WINDOW_INPOS_EXIT" });

      this.sellInPosExitDone = true;
    });
  }

  private startSellWindowFlat() {
    this.state = "IN_SELL_WINDOW";

    const a = ensureAnchor(this.sym);
    const sellLtp = a.sellLtpAnchor ?? nowLtp(this.sym) ?? 0;
    const breakoutPx = roundPrice(sellLtp + 1.0);

    const windowMs = 60_000;
    const windowEnd = Date.now() + windowMs;

    log(
      this.sym,
      `[SELL WINDOW FLAT] start 60s until ${fmtTs(
        windowEnd
      )} | anchor sellLtp=${fmtPx(sellLtp)} | breakoutPx=${fmtPx(breakoutPx)}`
    );

    // Single START-OF-WINDOW checks
    const startLtp = nowLtp(this.sym) ?? sellLtp;
    const lastBuyRef = a.savedLastBUYLTP;

    // Case 1: strength breakout above anchor
    if (startLtp > breakoutPx) {
      const forcedAnchor = roundPrice(sellLtp + 1.0);
      log(
        this.sym,
        `[SELL WINDOW FLAT] immediate breakout at start: LTP=${fmtPx(
          startLtp
        )} > breakoutPx=${fmtPx(
          breakoutPx
        )} → set pendingBuyAfterSell=false and force next BUY anchor=${fmtPx(forcedAnchor)}`
      );
      a.pendingBuyAfterSell = false;
      a.savedBUYLTP = forcedAnchor;
      a.savedLastBUYLTP = forcedAnchor;
    }

    // Timer: when it ends, we just go back to IDLE
    this.sellWindowTimer = setTimeout(() => {
      this.sellWindowTimer = null;
      this.state = "IDLE";
      log(this.sym, "[SELL WINDOW FLAT] window ended → IDLE");
    }, windowMs);
  }

  private clearSellTimerOnly() {
    if (this.sellWindowTimer) {
      clearTimeout(this.sellWindowTimer);
      this.sellWindowTimer = null;
    }
    this.sellInPosExitDone = false;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // BUY HANDLING
  // ───────────────────────────────────────────────────────────────────────────

  private onBuySignal(sig: Signal, forcedAnchor?: number) {
    // Respect silence after a BUY stop-out
    if (this.buySilenceUntil && Date.now() < this.buySilenceUntil) {
      debug(this.sym, `[BUY SIGNAL IGNORED] silenced until ${fmtTs(this.buySilenceUntil)}`);
      return;
    }

    const a = ensureAnchor(this.sym);

    if (a.pendingBuyAfterSell) {
      a.pendingBuyAfterSell = false;
      debug(this.sym, `[ANCHOR] first BUY after SELL @ ${fmtPx(sig.ltp)}`);
    }

    const saved = forcedAnchor ?? sig.ltp;
    const qty = computeQtyFromPnLContext(this.sym);
    const entryPx = roundPrice(saved + 0.5);
    const tag = forcedAnchor ? "BUY_SIGNAL_FORCED_ANCHOR" : "BUY_SIGNAL_PREWINDOW";

    debug(
      this.sym,
      `[BUY SIGNAL] savedBUYLTP=${fmtPx(
        saved
      )} → place BUY LIMIT qty=${qty} @ ${fmtPx(entryPx)} (tag=${tag})`
    );
    placeLimitBuy(this.sym, qty, entryPx, { tag });

    // Start a BUY window anchored at forcedAnchor or signal LTP
    this.startBuyWindow(saved);
  }

  private clearSellTimerOnlyAndGoIdle() {
    this.clearSellTimerOnly();
    this.state = "IDLE";
  }

  private clearBuyTimerOnly() {
    if (this.buyWindowTimer) {
      clearTimeout(this.buyWindowTimer);
      this.buyWindowTimer = null;
    }
  }

  private clearBuyOnly() {
    this.clearBuyTimerOnly();
    this.buyWindowActive = false;
    this.buySilenceUntil = null;
  }

  /**
   * Start a 60s BUY window anchored at `anchor`.
   * - STOP-OUT: if tick < anchor - 0.5 → exit, silence until window end.
   * - BREAKOUT: if flat and tick > anchor in-window → re-enter and restart window.
   * - TIMEOUT: at 60s, if flat and LTP > anchor → auto re-enter & new window; else → go IDLE.
   */
  private startBuyWindow(anchor: number) {
    const a = ensureAnchor(this.sym);

    // Reset BUY-only timers/context
    this.clearBuyOnly();

    a.savedBUYLTP = anchor;
    a.savedLastBUYLTP = anchor; // update last BUY reference
    a.buyWindowIdxSinceSell += 1;

    this.state = "IN_BUY_WINDOW";
    this.buyWindowActive = true;

    const windowMs = 60_000;
    const windowEnd = Date.now() + windowMs;

    log(
      this.sym,
      `[BUY WINDOW] start 60s (idx=${a.buyWindowIdxSinceSell}) until ${fmtTs(
        windowEnd
      )} | savedBUYLTP=${fmtPx(anchor)}`
    );

    // Tick watcher for BUY window
    onSymbolTick(this.sym, (tickLtp: number) => {
      if (!this.buyWindowActive) return;
      if (this.state !== "IN_BUY_WINDOW") return;

      const anchorPx = a.savedBUYLTP ?? anchor;
      const ltp = tickLtp;

      // A) STOP-OUT: tick < (anchor - 0.5)
      if (ltp < roundPrice(anchorPx - 0.5)) {
        const qty = getOpenQty(this.sym);
        if (qty > 0) {
          const px = roundPrice(ltp - 0.5);
          debug(
            this.sym,
            `[BUY STOP-OUT] tick=${fmtPx(
              ltp
            )} < (${fmtPx(anchorPx)} - 0.5) → EXIT qty=${qty} @ LIMIT=${fmtPx(
              px
            )}; IDLE & silent until ${fmtTs(windowEnd)}`
          );
          placeLimitSell(this.sym, qty, px, { tag: "BUY_WINDOW_STOP_OUT" });
        } else {
          debug(this.sym, "[BUY STOP-OUT] no open qty to exit");
        }

        // Stop-out → window is over, silence further BUY signals until window end
        this.buyWindowActive = false;
        this.state = "IDLE";
        this.buySilenceUntil = windowEnd;
        this.clearBuyTimerOnly();
        return;
      }

      // B) In-window breakout: flat + tick > anchor → re-enter and restart BUY window
      const flat = getOpenQty(this.sym) === 0;
      if (flat && ltp > anchorPx) {
        const qty2 = computeQtyFromPnLContext(this.sym);
        const px = roundPrice(ltp + 0.5);
        debug(
          this.sym,
          `[BUY WINDOW BREAKOUT] flat & tick=${fmtPx(
            ltp
          )} > anchor=${fmtPx(
            anchorPx
          )} → place BUY LIMIT qty=${qty2} @ ${fmtPx(px)} and restart BUY window`
        );
        placeLimitBuy(this.sym, qty2, px, { tag: "BUY_WINDOW_BREAKOUT_REENTER" });

        // Restart a fresh 60s BUY window from same anchor (loop)
        this.buyWindowActive = false;
        this.state = "IDLE";
        this.clearBuyTimerOnly();
        this.buySilenceUntil = null; // breakout is positive, no silence
        this.startBuyWindow(anchorPx);
        return;
      }
    });

    // BUY window timeout
    this.buyWindowTimer = setTimeout(() => {
      this.buyWindowTimer = null;
      this.buyWindowActive = false;

      const anchorPx = a.savedBUYLTP ?? anchor;
      this.buySilenceUntil = null; // clear any stop-out silence

      const ltpNow = nowLtp(this.sym) ?? anchorPx;
      const flat = getOpenQty(this.sym) === 0;

      // Log expiry and re-entry condition
      log(
        this.sym,
        `[BUY WINDOW EXPIRED] 60s window ended | flat=${flat ? "YES" : "NO"} | LTP=${fmtPx(
          ltpNow
        )} | savedBUYLTP=${fmtPx(anchorPx)}`
      );

      // If FLAT and LTP > savedBUYLTP at timeout → auto re-arm BUY and start a new window
      if (flat && ltpNow > anchorPx) {
        const qty2 = computeQtyFromPnLContext(this.sym);
        const px = roundPrice(ltpNow + 0.5);
        log(
          this.sym,
          `[BUY WINDOW RE-ENTRY] flat & LTP=${fmtPx(
            ltpNow
          )} > savedBUYLTP=${fmtPx(
            anchorPx
          )} → place BUY LIMIT qty=${qty2} @ ${fmtPx(px)} and start new 60s BUY window`
        );
        placeLimitBuy(this.sym, qty2, px, { tag: "BUY_TIMEOUT_BREAKOUT_REENTER" });

        this.state = "IDLE"; // startBuyWindow will set to IN_BUY_WINDOW
        this.startBuyWindow(anchorPx);
        return;
      }

      // Otherwise → plain timeout to IDLE with no re-entry
      this.state = "IDLE";
      log(
        this.sym,
        `[BUY WINDOW] window ended with no re-entry (flat=${flat ? "YES" : "NO"}, LTP=${fmtPx(
          ltpNow
        )}, savedBUYLTP=${fmtPx(anchorPx)}) → IDLE`
      );
    }, windowMs);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry & exports
// ─────────────────────────────────────────────────────────────────────────────

const MACHINES: Record<string, SymbolMachine> = {};

export function getMachine(sym: string): SymbolMachine {
  if (!MACHINES[sym]) {
    log(sym, "[INIT] machine for " + sym);
    MACHINES[sym] = new SymbolMachine(sym);
  }
  return MACHINES[sym];
}

export function handleBuySignal(sym: string, ltp: number, raw?: unknown, forcedAnchor?: number) {
  const m = getMachine(sym);
  m.handleSignal({ type: "BUY_SIGNAL", ltp, raw });
  if (forcedAnchor != null) {
    // optional override path: direct forced anchor BUY
    m["onBuySignal"]({ type: "BUY_SIGNAL", ltp, raw }, forcedAnchor);
  }
}

export function handleSellSignal(sym: string, ltp: number, reason?: string, raw?: unknown) {
  const m = getMachine(sym);
  m.handleSignal({ type: "SELL_SIGNAL", ltp, raw });
  const a = ensureAnchor(sym);
  a.lastSellReason = reason ?? "SELL_SIGNAL";
}
