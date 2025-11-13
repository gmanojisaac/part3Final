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
  ts: number;
  reason?: string;
  raw?: unknown;
}

type TimerHandle = ReturnType<typeof setTimeout> | null;

const fmtPx = (n: number | null | undefined) =>
  n == null || Number.isNaN(n) ? "—" : Number(n).toFixed(2);

const fmtTs = (ts: number) => new Date(ts).toTimeString().slice(0, 8);

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

  // Last "important" BUY anchor you care about for re-entry
  savedLastBUYLTP: number | null;

  // Mark that the next BUY is first after SELL (optional, kept for extensibility)
  pendingBuyAfterSell: boolean;

  // For logging / observability
  buyWindowIdxSinceSell: number;
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
    const a = ensureAnchor(this.sym);
    const openQty = getOpenQty(this.sym);

    // SELL anchor for this cycle: set ONLY here
    a.sellLtpAnchor = sig.ltp;
    a.pendingBuyAfterSell = true; // first BUY can be marked if you want
    a.buyWindowIdxSinceSell = 0;
    a.lastSellReason = sig.reason ?? "GENERIC";

    this.hadPositionOnSell = openQty > 0;

    log(
      this.sym,
      `Signal: SELL_SIGNAL @ LTP=${fmtPx(sig.ltp)} | state=${this.state} | hadPos=${this.hadPositionOnSell}`
    );

    this.clearSellTimerOnly();

    if (this.hadPositionOnSell) {
      this.startSellWindowInPosition();
    } else {
      this.startSellWindowFlat();
    }
  }

  /**
   * SELL flow when you HAVE a long position.
   * On first tick inside the SELL window, exit full qty @ (tick - 0.5).
   * Then do nothing else until window end.
   */
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
      this.sellInPosExitDone = false;
      this.hadPositionOnSell = false;
      log(this.sym, `[SELL WINDOW IN-POS] window ended → IDLE`);
    }, windowMs);

    // Tick handler: first tick triggers exit, then we ignore further ticks
    onSymbolTick(this.sym, (tickLtp: number) => {
      if (this.state !== "IN_SELL_WINDOW") return;
      if (!this.hadPositionOnSell) return; // just a guard
      if (this.sellInPosExitDone) return;

      const qty = getOpenQty(this.sym);
      if (qty > 0) {
        const px = roundPrice(tickLtp - 0.5);
        debug(
          this.sym,
          `[SELL IN-POS EXIT] EXIT qty=${qty} @ LIMIT=${fmtPx(px)} (tick=${fmtPx(
            tickLtp
          )}) → freeze until window end`
        );
        placeLimitSell(this.sym, qty, px, { tag: "SELL_INPOS_IMMEDIATE_EXIT" });
      } else {
        debug(this.sym, "[SELL IN-POS EXIT] no open qty at execution time");
      }

      this.sellInPosExitDone = true;
      // We intentionally do NOT clear the timer; we just wait out the window.
    });
  }

  /**
   * SELL flow when FLAT (no position).
   *
   * We:
   * - Use a single anchor sellLtp (stored in ANCHOR.sellLtpAnchor).
   * - Start a 60s SELL window.
   * - At the *start* of each SELL window, run two checks ONCE:
   *     1) LTP > sellLtp + 0.5 → flip to BUY with savedBUYLTP = sellLtp + 1.0
   *     2) else if LTP < savedLastBUYLTP → flip to BUY with savedBUYLTP = LTP
   *     3) else → stand aside for the entire window.
   * - On timeout (if we didn't flip), we start another 60s SELL window with the SAME sellLtp.
   * - A new SELL signal is the only thing that can change sellLtpAnchor.
   */
  private startSellWindowFlat() {
    const a = ensureAnchor(this.sym);
    const sellLtp = a.sellLtpAnchor ?? nowLtp(this.sym) ?? 0;
    a.sellLtpAnchor = sellLtp; // ensure it's set

    this.state = "IN_SELL_WINDOW";

    const windowMs = 60_000;
    const windowEnd = Date.now() + windowMs;
    const breakoutPx = roundPrice(sellLtp + 0.5);

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
        `[SELL FLAT START] LTP=${fmtPx(
          startLtp
        )} > sellLtp+0.5=${fmtPx(breakoutPx)} → flip to BUY (savedBUYLTP=${fmtPx(
          forcedAnchor
        )})`
      );
      this.state = "IDLE";
      this.flipToBuyFromSell(forcedAnchor, "SELL_FLAT_BREAKOUT");
      return;
    }

    // Case 2: re-entry below last BUY anchor
    if (lastBuyRef != null && startLtp < lastBuyRef) {
      const forcedAnchor = roundPrice(startLtp);
      log(
        this.sym,
        `[SELL FLAT START] LTP=${fmtPx(
          startLtp
        )} < savedLastBUYLTP=${fmtPx(lastBuyRef)} → flip to BUY (savedBUYLTP=${fmtPx(
          forcedAnchor
        )})`
      );
      this.state = "IDLE";
      this.flipToBuyFromSell(forcedAnchor, "SELL_FLAT_REENTRY_DISCOUNT");
      return;
    }

    // Else → stand aside this window
    log(
      this.sym,
      `[SELL FLAT START] LTP=${fmtPx(
        startLtp
      )} within neutral band → stand aside this SELL window`
    );

    // Let the window run 60s doing nothing, then re-start another SELL window
    this.sellWindowTimer = setTimeout(() => {
      this.sellWindowTimer = null;

      // Only re-loop if we are still in SELL state and FLAT (no new SELL or BUY changed us)
      if (this.state === "IN_SELL_WINDOW") {
        log(
          this.sym,
          `[SELL WINDOW FLAT] window ended with no action → restarting SELL window (same sellLtp=${fmtPx(
            a.sellLtpAnchor
          )})`
        );
        this.startSellWindowFlat();
      } else {
        debug(
          this.sym,
          `[SELL WINDOW FLAT] window ended but state=${this.state}, not restarting`
        );
      }
    }, windowMs);
  }

  /** Helper used by flat SELL flow to start BUY logic with a given anchor. */
  private flipToBuyFromSell(forcedAnchor: number, tag: string) {
    const a = ensureAnchor(this.sym);
    a.savedBUYLTP = forcedAnchor;
    a.savedLastBUYLTP = forcedAnchor; // update last BUY ref

    const entryPx = roundPrice(forcedAnchor + 0.5);
    const qty = computeQtyFromPnLContext(this.sym);

    debug(
      this.sym,
      `[FLIP TO BUY] from SELL (${tag}) → savedBUYLTP=${fmtPx(
        forcedAnchor
      )}, placing BUY qty=${qty} @ ${fmtPx(entryPx)}`
    );
    placeLimitBuy(this.sym, qty, entryPx, { tag });

    // Start a BUY window anchored at forcedAnchor
    this.startBuyWindow(forcedAnchor);
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
      // optional: capture anything; left for extensibility
      a.pendingBuyAfterSell = false;
      debug(this.sym, `[ANCHOR] first BUY after SELL @ ${fmtPx(sig.ltp)}`);
    }

    const saved = forcedAnchor ?? sig.ltp;
    a.savedBUYLTP = saved;

    // Immediate pre-window BUY attempt @ (saved + 0.5)
    const entryPx = roundPrice(saved + 0.5);
    const qty = computeQtyFromPnLContext(this.sym);

    debug(
      this.sym,
      `[BUY SIGNAL] savedBUYLTP=${fmtPx(saved)} → place BUY LIMIT qty=${qty} @ ${fmtPx(
        entryPx
      )}`
    );
    placeLimitBuy(this.sym, qty, entryPx, { tag: "BUY_SIGNAL_PREWINDOW" });

    if (this.state === "IDLE") {
      this.startBuyWindow(saved);
    } else {
      log(this.sym, "[BUY SIGNAL] active BUY window already running, not starting another");
    }
  }

  /**
   * Start a 60s BUY window anchored at savedBUYLTP.
   *
   * - Stop-out: tick < (anchor - 0.5) → exit full, go IDLE, silence until window end.
   * - Flat breakout: flat & tick > anchor → buy @ (tick + 0.5), start a fresh 60s BUY window.
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
          debug(this.sym, "[BUY STOP-OUT] condition met but no open qty");
        }

        this.buyWindowActive = false;
        this.state = "IDLE";
        this.buySilenceUntil = windowEnd;
        return;
      }

      // B) FLAT BREAKOUT: no position, tick > anchor
      if (getOpenQty(this.sym) === 0 && ltp > anchorPx) {
        const qty2 = computeQtyFromPnLContext(this.sym);
        const px = roundPrice(ltp + 0.5);
        debug(
          this.sym,
          `[BUY FLAT BREAKOUT] tick=${fmtPx(ltp)} > savedBUYLTP=${fmtPx(
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
      this.buySilenceUntil = null; // clear any stop-out silence
      this.state = "IDLE";
      log(this.sym, "[BUY WINDOW] window ended → IDLE");
    }, windowMs);
  }

  private clearBuyOnly() {
    this.clearBuyTimerOnly();
    this.buyWindowActive = false;
    this.buySilenceUntil = null;
  }

  private clearBuyTimerOnly() {
    if (this.buyWindowTimer) {
      clearTimeout(this.buyWindowTimer);
      this.buyWindowTimer = null;
    }
  }

  private clearTimers() {
    this.clearSellTimerOnly();
    this.clearBuyOnly();
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

export function handleSellSignal(sym: string, ltp: number, reason?: string, raw?: unknown) {
  getMachine(sym).handleSignal({
    type: "SELL_SIGNAL",
    ltp,
    ts: Date.now(),
    reason,
    raw,
  });
}

export function handleBuySignal(
  sym: string,
  ltp: number,
  raw?: unknown,
  forcedAnchor?: number
) {
  // We want to pass forcedAnchor into the machine's internal BUY handler.
  (getMachine(sym) as any).onBuySignal(
    { type: "BUY_SIGNAL", ltp, ts: Date.now(), raw },
    forcedAnchor
  );
}

// Compatibility class for existing webhook usage
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
    if (type === "BUY_SIGNAL") {
      handleBuySignal(this.symbol, px, raw);
    } else {
      handleSellSignal(this.symbol, px, reason, raw);
    }
  }
}
