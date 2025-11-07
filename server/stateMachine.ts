// server/stateMachine.ts
import {
  getQuotesV3,
  placeLimitOrderV3,
  cancelOrderV3,
  getOrderStatusV3,
  isOrderPending,
} from "./fyersClient";
import { calculateQuantityForOrderValue } from "./quantityCalc";
import { roundToTick, nowIST } from "./helpers";
import { upsert, PersistedMachine } from "./stateStore";

type State = "IDLE" | "PENDING_ENTRY" | "LONG_ACTIVE";
type Signal = "BUY_SIGNAL" | "SELL_SIGNAL";

export interface MachineConfig {
  symbol: string;           // e.g. "NSE:NIFTY25N1125700CE"
  underlying: string;       // "NIFTY" | "BANKNIFTY"
  slPoints?: number;        // 0.5 for first entry of a cycle
  orderValue?: number;      // default ₹1L
}

const ENTRY_TTL_MS = Number(process.env.ENTRY_TTL_MS ?? 15000);
const ENTRY_OFFSET  = Number(process.env.ENTRY_OFFSET  ?? 0.5);
const EXIT_OFFSET   = Number(process.env.EXIT_OFFSET   ?? 0.5);

export class TradeStateMachine {
  private readonly symbol: string;
  private readonly underlying: string;
  private readonly slPoints: number;
  private readonly orderValue: number;

  private state: State = "IDLE";

  private prevSavedLTP: number | null = null;
  private buySignalAt: number | null = null;
  private reentryDeadline: number | null = null;
  private reentryTimer: NodeJS.Timeout | null = null;

  private rollingActive = false;
  private cancelReentryDueToSell = false;

  private sellArmed = false;
  private sellArmRefLTP: number | null = null;

  private entryOrderId?: string;
  private entryRefLTP: number | null = null;
  private exiting = false;

  // per-BUY-cycle index: 1 = first fill; 2+ = subsequent fills
  private entryIndexInBuyCycle = 0;

  // NEW: once a loss exit happens during the 60s window, block further entries until window end
  private noReentryThisWindow = false;

  constructor(cfg: MachineConfig) {
    this.symbol      = cfg.symbol;
    this.underlying  = cfg.underlying.toUpperCase();
    this.slPoints    = cfg.slPoints ?? 0.5;
    this.orderValue  = cfg.orderValue ?? 100000;
    this.log(`[INIT] StateMachine created`);
    this.persist();
  }

  private log(msg: string) { console.log(`[${nowIST()}] [${this.symbol}] ${msg}`); }

  private persist() {
    const p: PersistedMachine & {
      entryIndexInBuyCycle?: number;
      noReentryThisWindow?: boolean;
    } = {
      symbol: this.symbol,
      underlying: this.underlying,
      state: this.state,
      prevSavedLTP: this.prevSavedLTP,
      buySignalAt: this.buySignalAt,
      reentryDeadline: this.reentryDeadline,
      rollingActive: this.rollingActive,
      cancelReentryDueToSell: this.cancelReentryDueToSell,
      sellArmed: this.sellArmed,
      sellArmRefLTP: this.sellArmRefLTP,
      entryOrderId: this.entryOrderId,
      entryRefLTP: this.entryRefLTP,
      slPoints: this.slPoints,
      orderValue: this.orderValue,
      entryIndexInBuyCycle: this.entryIndexInBuyCycle,
      noReentryThisWindow: this.noReentryThisWindow,
    };
    upsert(p);
  }

  public static fromPersisted(p: PersistedMachine & {
    entryIndexInBuyCycle?: number;
    noReentryThisWindow?: boolean;
  }) {
    const m = new TradeStateMachine({
      symbol: p.symbol,
      underlying: p.underlying,
      slPoints: p.slPoints,
      orderValue: p.orderValue,
    });
    (m as any).state = p.state;
    (m as any).prevSavedLTP = p.prevSavedLTP;
    (m as any).buySignalAt = p.buySignalAt;
    (m as any).reentryDeadline = p.reentryDeadline;
    (m as any).rollingActive = (p as any).rollingActive;
    (m as any).cancelReentryDueToSell = p.cancelReentryDueToSell;
    (m as any).sellArmed = p.sellArmed;
    (m as any).sellArmRefLTP = p.sellArmRefLTP;
    (m as any).entryOrderId = p.entryOrderId;
    (m as any).entryRefLTP = p.entryRefLTP;
    (m as any).entryIndexInBuyCycle = p.entryIndexInBuyCycle ?? 0;
    (m as any).noReentryThisWindow = p.noReentryThisWindow ?? false;
    m.log(`[RESUME] rehydrated from disk with state=${p.state}, idx=${(m as any).entryIndexInBuyCycle}, windowBlock=${(m as any).noReentryThisWindow}`);
    m.persist();
    return m;
  }

  getState() { return this.state; }

  async onSignal(sig: Signal, ltpHint?: number) {
    const ltp = await this.ensureLTP(ltpHint);
    this.log(`Signal: ${sig} @ LTP=${ltp.toFixed(2)} | state=${this.state}`);
    if (sig === "BUY_SIGNAL")  return this.onBuySignal(ltp);
    if (sig === "SELL_SIGNAL") return this.onSellSignal(ltp);
  }

  async onTick(ltp: number) {
    // Loss-exit rules (first vs subsequent entries under same BUY cycle)
    if (!this.exiting && this.state === "LONG_ACTIVE") {
      let shouldExit = false;
      let thresholdDesc = "";
      let thresholdVal = 0;

      if (this.entryIndexInBuyCycle <= 1) {
        if (this.entryRefLTP != null) {
          const thresh = this.entryRefLTP - this.slPoints;
          if (ltp <= thresh) { shouldExit = true; thresholdDesc = `entryRefLTP - ${this.slPoints}`; thresholdVal = thresh; }
        }
      } else {
        if (this.prevSavedLTP != null) {
          if (ltp < this.prevSavedLTP) { shouldExit = true; thresholdDesc = "prevSavedLTP"; thresholdVal = this.prevSavedLTP; }
        }
      }

      if (shouldExit) {
        this.exiting = true;
        this.log(`[LOSS EXIT] idx=${this.entryIndexInBuyCycle} ltp=${ltp.toFixed(2)} <= ${thresholdDesc}(${thresholdVal.toFixed(2)}) ⇒ exit @ (ltp-0.5)`);
        await this.exitLong("LOSS_EXIT", ltp);

        // NEW: if inside the 60s window, block any further entries until window end
        if (this.withinWindow()) {
          this.noReentryThisWindow = true;
          this.log(`[WINDOW BLOCK] Loss exit during 60s window → block re-entries until window ends`);
        }

        this.exiting = false;
        this.persist();
        return;
      }
    }

    // SELL-armed drop exit while long (unchanged)
    if (this.state === "LONG_ACTIVE" && this.sellArmed && this.sellArmRefLTP != null) {
      if (ltp <= this.sellArmRefLTP - this.slPoints) {
        if (!this.exiting) {
          this.exiting = true;
          this.log(`[SELL-ARM DROP EXIT] ltp=${ltp.toFixed(2)} <= ${(this.sellArmRefLTP - this.slPoints).toFixed(2)}`);
          await this.exitLong("SELL_ARM_DROP_EXIT", ltp);

          if (this.withinWindow()) {
            this.noReentryThisWindow = true;
            this.log(`[WINDOW BLOCK] Sell-armed loss exit during 60s window → block re-entries until window ends`);
          }

          this.exiting = false;
          this.persist();
        }
      }
    }
  }

  private async onBuySignal(ltp: number) {
    // New BUY signal = new 60s window (reset the window block)
    this.noReentryThisWindow = false;
    this.entryIndexInBuyCycle = 0;

    if (this.state === "IDLE" && this.rollingActive) {
      this.log(`[BUY SIGNAL] overrides rolling re-entry loop — stopping loop and entering now`);
      this.stopRollingReentry();
    }

    if (this.state !== "IDLE") {
      this.log(`BUY ignored — current state=${this.state}`);
      this.persist();
      return;
    }

    this.prevSavedLTP = ltp;
    const now = Date.now();
    this.buySignalAt = now;
    this.reentryDeadline = now + 60_000;
    this.cancelReentryDueToSell = false;

    this.resetSellArming();
    this.log(`[BUY SIGNAL] → start 60s window (until ${new Date(this.reentryDeadline).toLocaleTimeString("en-GB",{ timeZone: "Asia/Kolkata" })} IST). Baseline savedLTP=${this.prevSavedLTP.toFixed(2)}`);

    await this.enterLong(ltp);

    this.clearReentryTimer();
    this.reentryTimer = setTimeout(() => this.onReentryDeadline(), 60_000);
    this.persist();
  }

  private async onSellSignal(_ltp: number) {
    this.log(`[SELL SIGNAL] state=${this.state}`);
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
        this.sellArmed = true;
        const ltp = await this.ensureLTP();
        this.sellArmRefLTP = ltp;
        this.log(`[SELL] Armed drop-exit @ <= ${(this.sellArmRefLTP - this.slPoints).toFixed(2)}`);
        break;
      }
      case "IDLE":
      default: break;
    }
    this.persist();
  }

  private async enterLong(ltp: number) {
    if (this.noReentryThisWindow && this.withinWindow()) {
      this.log(`[ENTER LONG] blocked — window currently disallows re-entry`);
      return;
    }

    const qty = calculateQuantityForOrderValue(this.underlying, ltp, this.orderValue);

    this.entryRefLTP = ltp;
    const buyLimit = roundToTick(ltp + ENTRY_OFFSET);
    this.log(`[ENTER LONG] idx=${this.entryIndexInBuyCycle + 1} qty=${qty}, LIMIT=${buyLimit}, LTP=${ltp}`);

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
    this.persist();

    // TTL: only re-place if still pending, and not window-blocked
    setTimeout(async () => {
      if (this.state !== "PENDING_ENTRY" || !this.entryOrderId) return;

      // If window-blocked, just try to cancel and stop
      if (this.noReentryThisWindow && this.withinWindow()) {
        this.log(`[ENTRY TTL] window-blocked → cancel pending and skip re-place`);
        await cancelOrderV3(this.entryOrderId);
        this.entryOrderId = undefined;
        this.state = "IDLE";
        this.persist();
        return;
      }

      // 1) Check order status first
      try {
        const st = await getOrderStatusV3(this.entryOrderId);
        if (st.found) {
          if (!isOrderPending(st.status)) {
            this.log(`[ENTRY TTL] status=${st.status} → no re-place`);
            if (String(st.status).toUpperCase() === "FILLED") this.onEntryFilled();
            return;
          }
        }
      } catch {}

      // 2) Try to cancel; if broker says -52, do NOT re-place
      this.log(`[ENTRY TTL] cancelling stale entry ${this.entryOrderId} and (maybe) re-placing...`);
      const cancelRes: any = await cancelOrderV3(this.entryOrderId);
      const notPending = cancelRes?.code === -52;
      if (notPending) {
        this.log(`[ENTRY TTL] cancel says not pending → skip re-place`);
        return;
      }
      this.entryOrderId = undefined;

      // 3) Re-place fresh at current LTP+0.5 (only if not window-blocked)
      if (this.noReentryThisWindow && this.withinWindow()) {
        this.log(`[ENTRY TTL] window-blocked after cancel → skip re-place`);
        this.state = "IDLE";
        this.persist();
        return;
      }

      const nowLtp = await this.ensureLTP();
      const newQty = calculateQuantityForOrderValue(this.underlying, nowLtp, this.orderValue);
      const newLim = roundToTick(nowLtp + ENTRY_OFFSET);

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
      this.persist();
    }, ENTRY_TTL_MS);
  }

  public onEntryFilled() {
    if (this.state === "PENDING_ENTRY") {
      this.state = "LONG_ACTIVE";
      this.entryIndexInBuyCycle += 1;
      this.log(`[FILL] Entry filled → LONG_ACTIVE (cycle idx=${this.entryIndexInBuyCycle})`);
      this.persist();
    }
  }

  private async exitLong(reason: string, ltpNow?: number) {
    const ltp = await this.ensureLTP(ltpNow);
    const qty = calculateQuantityForOrderValue(this.underlying, ltp, this.orderValue);
    const sellLimit = roundToTick(ltp - EXIT_OFFSET);

    this.log(`[EXIT LONG] reason=${reason}, idx=${this.entryIndexInBuyCycle}, qty=${qty}, limit=${sellLimit}, LTP=${ltp}`);

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
    this.persist();

    // NOTE: if exit happened inside the 60s window, we do NOT start rolling re-entry now.
    if (!this.withinWindow() && reason !== "SELL_ARM_DROP_EXIT") {
      // For post-window loss exits, keep previous behavior if you like:
      // this.startRollingReentry();
    }
  }

  private async onReentryDeadline() {
    if (!this.reentryDeadline) return;

    this.log(`[REENTRY CHECK @60s] window expired, evaluating...`);
    this.reentryTimer = null;

    // If blocked for this window, do nothing.
    if (this.noReentryThisWindow) {
      this.log(`[REENTRY CHECK] window-blocked flag set → skipping re-entry`);
      this.clearWindowAndLoop();
      return;
    }

    if (this.state !== "IDLE") return;
    if (this.cancelReentryDueToSell) return;
    if (this.prevSavedLTP == null) return;

    const ltp = await this.ensureLTP();
    if (ltp > this.prevSavedLTP) {
      this.log(`[REENTRY OK] LTP ${ltp} > prev ${this.prevSavedLTP} → re-enter`);
      await this.enterLong(ltp);
    } else {
      this.log(`[REENTRY FAIL] LTP ${ltp} ≤ prev ${this.prevSavedLTP} — no re-entry`);
    }
    this.persist();
  }

  private startRollingReentry() {
    if (this.cancelReentryDueToSell) return;
    if (this.prevSavedLTP == null) {
      this.log(`[REENTRY ROLLING] cannot start — prevSavedLTP is null`);
      return;
    }
    this.rollingActive = true;
    this.reentryDeadline = Date.now() + 60_000;
    this.clearReentryTimer();
    this.reentryTimer = setTimeout(() => this.checkRollingReentry(), 60_000);
    this.log(`[REENTRY ROLLING] started 60s cooldown (until ${new Date(this.reentryDeadline).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" })} IST) waiting for LTP > ${this.prevSavedLTP.toFixed(2)}`);
    this.persist();
  }

  private stopRollingReentry() {
    if (!this.rollingActive) return;
    this.rollingActive = false;
    this.clearReentryTimer();
    this.reentryDeadline = null;
    this.log(`[REENTRY ROLLING] stopped`);
    this.persist();
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
      this.persist();
    } else {
      this.log(`[REENTRY ROLLING] WAIT: LTP ${ltp} ≤ prev ${this.prevSavedLTP} — schedule next 60s`);
      this.startRollingReentry();
    }
  }

  private clearReentryTimer() { if (this.reentryTimer) clearTimeout(this.reentryTimer); this.reentryTimer = null; }

  private clearWindowAndLoop() {
    this.clearReentryTimer();
    this.buySignalAt = null;
    this.reentryDeadline = null;
    this.cancelReentryDueToSell = false;
    this.rollingActive = false;
    // Do not touch noReentryThisWindow here — it naturally expires since window ended
    this.persist();
  }

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
      this.persist();
    }
  }

  private resetSellArming() {
    this.sellArmed = false;
    this.sellArmRefLTP = null;
  }
}
