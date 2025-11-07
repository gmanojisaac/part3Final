// server/stateMachine.ts
import {
  getQuotesV3,
  placeLimitOrderV3,
  cancelOrderV3,
} from "./fyersClient";
import { calculateQuantityForOrderValue } from "./quantityCalc";
import { roundToTick, nowIST } from "./helpers";

type State = "IDLE" | "PENDING_ENTRY" | "LONG_ACTIVE";
type Signal = "BUY_SIGNAL" | "SELL_SIGNAL";

export interface MachineConfig {
  symbol: string;           // FYERS tradingsymbol, e.g. "NSE:NIFTY25N1125700CE"
  underlying: string;       // "NIFTY" | "BANKNIFTY"
  slPoints?: number;        // default 0.5 (used for manual entry-ref drop & SELL-armed drop)
  orderValue?: number;      // default ₹1L notional sizing
}

// Offsets (can be overridden via .env)
const ENTRY_TTL_MS = Number(process.env.ENTRY_TTL_MS ?? 15000); // re-chase after 15s if still pending
const ENTRY_OFFSET  = Number(process.env.ENTRY_OFFSET  ?? 0.5); // Buy @ LTP + 0.5
const EXIT_OFFSET   = Number(process.env.EXIT_OFFSET   ?? 0.5); // Sell @ LTP - 0.5

export class TradeStateMachine {
  // ---- configuration ----
  private readonly symbol: string;
  private readonly underlying: string;
  private readonly slPoints: number;
  private readonly orderValue: number;

  // ---- state ----
  private state: State = "IDLE";

  // BUY-signal-driven 60s window (original)
  private prevSavedLTP: number | null = null;  // saved when BUY signal arrives
  private buySignalAt: number | null = null;   // epoch ms
  private reentryDeadline: number | null = null;
  private reentryTimer: NodeJS.Timeout | null = null;

  // Rolling re-entry loop after a loss exit
  private rollingActive = false;

  // Cancellation flags
  private cancelReentryDueToSell = false;      // any SELL cancels re-entry attempts

  // SELL arming: drop-exit when ltp <= ref - slPoints
  private sellArmed = false;
  private sellArmRefLTP: number | null = null;

  // order ids we place/track (for cancels)
  private entryOrderId?: string;

  // Manual entry reference: exit if current ltp <= entryRefLTP - slPoints
  private entryRefLTP: number | null = null;

  // Guard against double exits on the same tick
  private exiting = false;

  constructor(cfg: MachineConfig) {
    this.symbol      = cfg.symbol;
    this.underlying  = cfg.underlying.toUpperCase();
    this.slPoints    = cfg.slPoints ?? 0.5;
    this.orderValue  = cfg.orderValue ?? 100000;
    this.log(`[INIT] StateMachine created`);
  }

  // ---------- logging ----------
  private log(msg: string) {
    console.log(`[${nowIST()}] [${this.symbol}] ${msg}`);
  }

  // ---------- public API ----------
  getState() {
    return this.state;
  }

  /** Feed BUY/SELL signals (from webhook) with an optional LTP hint. */
  async onSignal(sig: Signal, ltpHint?: number) {
    const ltp = await this.ensureLTP(ltpHint);
    this.log(`Signal: ${sig} @ LTP=${ltp.toFixed(2)} | state=${this.state}`);

    if (sig === "BUY_SIGNAL")  return this.onBuySignal(ltp);
    if (sig === "SELL_SIGNAL") return this.onSellSignal(ltp);
  }

  /** Feed ticks (from DataSocket) for armed drop exits & manual entry-ref drop exit. */
  async onTick(ltp: number) {
    // Manual guard based on saved entry LTP
    if (!this.exiting && this.entryRefLTP != null) {
      const thresh = this.entryRefLTP - this.slPoints; // e.g., 0.5
      if (ltp <= thresh) {
        this.exiting = true;
        this.log(`[ENTRY-REF DROP] ltp=${ltp.toFixed(2)} <= ${thresh.toFixed(2)} ⇒ exit @ (ltp-0.5)`);
        await this.exitLong("ENTRY_REF_DROP_EXIT", ltp);
        this.entryRefLTP = null;
        this.exiting = false;
        return;
      }
    }

    // SELL-armed drop-exit while long
    if (this.state === "LONG_ACTIVE" && this.sellArmed && this.sellArmRefLTP != null) {
      if (ltp <= this.sellArmRefLTP - this.slPoints) {
        if (!this.exiting) {
          this.exiting = true;
          this.log(`[SELL-ARM DROP EXIT] ltp=${ltp.toFixed(2)} <= ${(this.sellArmRefLTP - this.slPoints).toFixed(2)}`);
          await this.exitLong("SELL_ARM_DROP_EXIT", ltp);
          this.exiting = false;
        }
      }
    }
  }

  // ---------- signal handlers ----------
  private async onBuySignal(ltp: number) {
    // If we’re idle and rolling re-entry is active, a new BUY signal overrides it.
    if (this.state === "IDLE" && this.rollingActive) {
      this.log(`[BUY SIGNAL] overrides active rolling re-entry loop — stopping loop and entering now`);
      this.stopRollingReentry();
    }

    if (this.state !== "IDLE") {
      this.log(`BUY ignored — current state=${this.state}`);
      return;
    }

    // Start 60s window NOW (from BUY signal time)
    this.prevSavedLTP = ltp;
    const now = Date.now();
    this.buySignalAt = now;
    this.reentryDeadline = now + 60_000;
    this.cancelReentryDueToSell = false;

    this.resetSellArming();
    this.log(`[BUY SIGNAL] → start 60s window (until ${new Date(this.reentryDeadline).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" })} IST)`);

    // (Re)arm the first entry immediately
    await this.enterLong(ltp);

    // Schedule the original one-shot 60s check; if it fails, we can later fall into rolling loop after a loss exit
    this.clearReentryTimer();
    this.reentryTimer = setTimeout(() => this.onReentryDeadline(), 60_000);
  }

  private async onSellSignal(_ltp: number) {
    this.log(`[SELL SIGNAL] state=${this.state}`);
    // SELL cancels any re-entry attempts (both original window & rolling loop)
    this.cancelReentryDueToSell = true;

    switch (this.state) {
      case "PENDING_ENTRY": {
        await this.cancelOpenEntryIfTracked();
        this.state = "IDLE";
        this.resetSellArming();
        this.log(`Cancelled pending entry on SELL signal → IDLE`);
        break;
      }
      case "LONG_ACTIVE": {
        // First or subsequent SELL: (re)arm drop exit reference
        this.sellArmed = true;
        // We use live ticks to update reference when SELL signal arrives; safer to fetch LTP
        const ltp = await this.ensureLTP();
        this.sellArmRefLTP = ltp;
        this.log(`[SELL] Armed drop-exit @ <= ${(this.sellArmRefLTP - this.slPoints).toFixed(2)}`);
        break;
      }
      case "IDLE":
      default: {
        // nothing else
        break;
      }
    }
  }

  // ---------- orders ----------
  private async enterLong(ltp: number) {
    const qty = calculateQuantityForOrderValue(this.underlying, ltp, this.orderValue);

    // Save & log entry LTP for manual drop guard
    this.entryRefLTP = ltp;
    this.log(`[ENTRY REF] saved LTP = ${ltp.toFixed(2)}`);

    // BUY with marketable limit: LTP + 0.5
    const buyLimit = roundToTick(ltp + ENTRY_OFFSET);
    this.log(`[ENTER LONG] qty=${qty}, LIMIT=${buyLimit}, LTP=${ltp}`);

    const entry = await placeLimitOrderV3({
      symbol: this.symbol,
      side: "BUY",
      qty,
      limitPrice: buyLimit,
      productType: "INTRADAY",
      validity: "DAY",
    });
    this.entryOrderId = entry?.id;
    this.log(`→ Entry order id=${this.entryOrderId}`);

    this.state = "PENDING_ENTRY";

    // TTL: cancel & re-place entry if still pending after ENTRY_TTL_MS
    setTimeout(async () => {
      if (this.state !== "PENDING_ENTRY" || !this.entryOrderId) return;
      this.log(`[ENTRY TTL] cancelling stale entry ${this.entryOrderId} and re-placing...`);

      await cancelOrderV3(this.entryOrderId);
      this.entryOrderId = undefined;

      const nowLtp  = await this.ensureLTP();
      const newQty  = calculateQuantityForOrderValue(this.underlying, nowLtp, this.orderValue);
      const newLim  = roundToTick(nowLtp + ENTRY_OFFSET);

      const re = await placeLimitOrderV3({
        symbol: this.symbol,
        side: "BUY",
        qty: newQty,
        limitPrice: newLim,
        productType: "INTRADAY",
        validity: "DAY",
      });
      this.entryOrderId = re?.id;
      this.log(`[ENTRY TTL] re-placed entry order=${this.entryOrderId} @ limit=${newLim}`);
    }, ENTRY_TTL_MS);
  }

  /** Call this when the broker confirms the entry is filled (wire via order/trade updates). */
  public onEntryFilled() {
    if (this.state === "PENDING_ENTRY") {
      this.state = "LONG_ACTIVE";
      this.log(`[FILL] Entry filled → LONG_ACTIVE`);
    }
  }

  /** Exit using marketable LIMIT (Sell @ LTP - 0.5), then cancel any open entry (safety). */
  private async exitLong(reason: string, ltpNow?: number) {
    const ltp = await this.ensureLTP(ltpNow);
    const qty = calculateQuantityForOrderValue(this.underlying, ltp, this.orderValue);
    const sellLimit = roundToTick(ltp - EXIT_OFFSET);

    this.log(`[EXIT LONG] reason=${reason}, qty=${qty}, limit=${sellLimit}, LTP=${ltp}`);

    try {
      await placeLimitOrderV3({
        symbol: this.symbol,
        side: "SELL",
        qty,
        limitPrice: sellLimit,
        productType: "INTRADAY",
        validity: "DAY",
      });
    } catch (e) {
      this.log(`Exit error: ${(e as Error).message}`);
    }

    await this.cancelOpenEntryIfTracked();
    this.resetSellArming();
    this.entryRefLTP = null;
    this.state = "IDLE";

    // If we exited due to a DROP (loss exit), start rolling 60s re-entry checks
    if (reason === "ENTRY_REF_DROP_EXIT" || reason === "SELL_ARM_DROP_EXIT") {
      // Keep prevSavedLTP from the original BUY signal
      this.startRollingReentry(); // will repeat every 60s until LTP > prevSavedLTP or a new BUY signal arrives / SELL cancels
    } else {
      // profit/other exits: clear any pending window/loop
      this.clearWindowAndLoop();
    }
  }

  // ---------- 60s re-entry (original single-shot) ----------
  private async onReentryDeadline() {
    if (!this.reentryDeadline) return;

    this.log(`[REENTRY CHECK @60s] window expired, evaluating...`);
    this.reentryTimer = null;

    if (this.state !== "IDLE") return;
    if (this.cancelReentryDueToSell) return;
    if (this.prevSavedLTP == null) return;

    const ltp = await this.ensureLTP();
    if (ltp > this.prevSavedLTP) {
      this.log(`[REENTRY OK] LTP ${ltp} > prev ${this.prevSavedLTP} → re-enter`);
      await this.enterLong(ltp);
      this.clearWindowAndLoop();
    } else {
      this.log(`[REENTRY FAIL] LTP ${ltp} ≤ prev ${this.prevSavedLTP} — no re-entry from this one-shot check`);
      // We **do not** start rolling here; rolling begins only after a **loss exit** per your spec.
    }
  }

  // ---------- Rolling re-entry loop (NEW) ----------
  private startRollingReentry() {
    if (this.cancelReentryDueToSell) return; // already cancelled by SELL
    if (this.prevSavedLTP == null) {
      this.log(`[REENTRY ROLLING] cannot start — prevSavedLTP is null`);
      return;
    }
    this.rollingActive = true;
    this.reentryDeadline = Date.now() + 60_000;
    this.clearReentryTimer();
    this.reentryTimer = setTimeout(() => this.checkRollingReentry(), 60_000);
    this.log(`[REENTRY ROLLING] started 60s cooldown (until ${new Date(this.reentryDeadline).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" })} IST)`);
  }

  private stopRollingReentry() {
    if (!this.rollingActive) return;
    this.rollingActive = false;
    this.clearReentryTimer();
    this.reentryDeadline = null;
    this.log(`[REENTRY ROLLING] stopped`);
  }

  private async checkRollingReentry() {
    this.reentryTimer = null;
    if (!this.rollingActive) return;
    if (this.state !== "IDLE") {
      this.log(`[REENTRY ROLLING] aborted — state=${this.state}`);
      this.stopRollingReentry();
      return;
    }
    if (this.cancelReentryDueToSell) {
      this.log(`[REENTRY ROLLING] cancelled by SELL signal`);
      this.stopRollingReentry();
      return;
    }
    if (this.prevSavedLTP == null) {
      this.log(`[REENTRY ROLLING] prevSavedLTP missing — stopping`);
      this.stopRollingReentry();
      return;
    }

    const ltp = await this.ensureLTP();
    if (ltp > this.prevSavedLTP) {
      this.log(`[REENTRY ROLLING] OK: LTP ${ltp} > prev ${this.prevSavedLTP} → re-enter now`);
      await this.enterLong(ltp);
      this.stopRollingReentry();
      // starting a fresh 60s window from BUY signal will happen inside onBuySignal next time;
      // here we just executed a direct re-entry per rolling rule (no external signal)
      // You can set prevSavedLTP = ltp if you want a new baseline for subsequent logic:
      this.prevSavedLTP = ltp;
    } else {
      this.log(`[REENTRY ROLLING] WAIT: LTP ${ltp} ≤ prev ${this.prevSavedLTP} — schedule next 60s`);
      this.startRollingReentry(); // schedule next cycle
    }
  }

  private clearReentryTimer() {
    if (this.reentryTimer) clearTimeout(this.reentryTimer);
    this.reentryTimer = null;
  }

  private clearWindowAndLoop() {
    this.clearReentryTimer();
    this.buySignalAt = null;
    this.reentryDeadline = null;
    this.cancelReentryDueToSell = false;
    this.rollingActive = false;
  }

  // ---------- helpers ----------
  private withinWindow(): boolean {
    return this.reentryDeadline != null && Date.now() <= this.reentryDeadline!;
  }

  private async ensureLTP(pref?: number): Promise<number> {
    if (pref && pref > 0) return pref;
    const q = await getQuotesV3([this.symbol]);
    const l = q?.d?.[0]?.v?.lp;
    if (!l) throw new Error(`LTP not found for ${this.symbol}`);
    return l;
  }

  private async cancelOpenEntryIfTracked() {
    if (this.entryOrderId) {
      this.log(`Cancelling entry order id=${this.entryOrderId}`);
      await cancelOrderV3(this.entryOrderId);
      this.entryOrderId = undefined;
    }
  }

  private resetSellArming() {
    this.sellArmed = false;
    this.sellArmRefLTP = null;
  }
}
