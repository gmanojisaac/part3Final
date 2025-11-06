// server/stateMachine.ts
import {
  getQuotesV3,
  placeLimitOrderV3,
  cancelOrderV3,
  getOrderStatus,
  OrderStatusRow,
  isCancelOk,
  isCancelNotPending,
} from "./fyersClient";
import { calculateQuantityForOrderValue } from "./quantityCalc";
import { roundToTick, nowIST } from "./helpers";

type State = "IDLE" | "PENDING_ENTRY" | "LONG_ACTIVE";
type Signal = "BUY_SIGNAL" | "SELL_SIGNAL";

export interface MachineConfig {
  symbol: string;           // FYERS tradingsymbol
  underlying: string;       // "NIFTY" | "BANKNIFTY"
  slPoints?: number;        // default 0.5
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

  // 60s re-entry window
  private prevSavedLTP: number | null = null;
  private buySignalAt: number | null = null;
  private reentryDeadline: number | null = null;
  private reentryTimer: NodeJS.Timeout | null = null;
  private cancelReentryDueToSell = false;
  private stoppedOutDuringWindow = false;

  // SELL arming
  private sellArmed = false;
  private sellArmRefLTP: number | null = null;

  // orders
  private entryOrderId?: string;

  // manual entry-ref
  private entryRefLTP: number | null = null;

  // guard
  private exiting = false;

  constructor(cfg: MachineConfig) {
    this.symbol      = cfg.symbol;
    this.underlying  = cfg.underlying.toUpperCase();
    this.slPoints    = cfg.slPoints ?? 0.5;
    this.orderValue  = cfg.orderValue ?? 100000;
    this.log(`[INIT] StateMachine created`);
  }

  private log(msg: string) {
    console.log(`[${nowIST()}] [${this.symbol}] ${msg}`);
  }

  getState() { return this.state; }

  async onSignal(sig: Signal, ltpHint?: number) {
    const ltp = await this.ensureLTP(ltpHint);
    this.log(`Signal: ${sig} @ LTP=${ltp.toFixed(2)} | state=${this.state}`);
    if (sig === "BUY_SIGNAL")  return this.onBuySignal(ltp);
    if (sig === "SELL_SIGNAL") return this.onSellSignal(ltp);
  }

  async onTick(ltp: number) {
    if (!this.exiting && this.entryRefLTP != null) {
      const thresh = this.entryRefLTP - this.slPoints;
      if (ltp <= thresh) {
        this.exiting = true;
        this.log(`[ENTRY-REF DROP] ltp=${ltp.toFixed(2)} <= ${thresh.toFixed(2)} ⇒ exit @ (ltp-0.5)`);
        await this.exitLong("ENTRY_REF_DROP_EXIT", ltp);
        this.entryRefLTP = null;
        this.exiting = false;
        return;
      }
    }

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

  private async onBuySignal(ltp: number) {
    if (this.state !== "IDLE") {
      this.log(`BUY ignored — current state=${this.state}`);
      return;
    }

    this.prevSavedLTP = ltp;
    const now = Date.now();
    this.buySignalAt = now;
    this.reentryDeadline = now + 60_000;
    this.cancelReentryDueToSell = false;
    this.stoppedOutDuringWindow = false;

    if (this.reentryTimer) clearTimeout(this.reentryTimer);
    const msLeft = Math.max(0, this.reentryDeadline - now);
    this.reentryTimer = setTimeout(() => this.onReentryDeadline(), msLeft);

    this.log(
      `[BUY SIGNAL] → start 60s window (until ${new Date(this.reentryDeadline).toLocaleTimeString(
        "en-GB",
        { timeZone: "Asia/Kolkata" }
      )} IST)`
    );
    await this.enterLong(ltp);
  }

  private async onSellSignal(ltp: number) {
    this.log(`[SELL SIGNAL] state=${this.state}`);
    switch (this.state) {
      case "PENDING_ENTRY": {
        await this.cancelOpenEntryIfTracked();
        this.state = "IDLE";
        if (this.withinWindow()) this.cancelReentryDueToSell = true;
        this.resetSellArming();
        this.log(`Cancelled pending entry on SELL signal → IDLE`);
        break;
      }
      case "LONG_ACTIVE": {
        this.sellArmed = true;
        this.sellArmRefLTP = ltp;
        this.log(`[SELL] Armed drop-exit @ <= ${(this.sellArmRefLTP - this.slPoints).toFixed(2)}`);
        break;
      }
      case "IDLE":
      default: {
        if (this.withinWindow()) this.cancelReentryDueToSell = true;
        break;
      }
    }
  }

  private async enterLong(ltp: number) {
    const qty = calculateQuantityForOrderValue(this.underlying, ltp, this.orderValue);
    this.entryRefLTP = ltp;
    this.log(`[ENTRY REF] saved LTP = ${ltp.toFixed(2)}`);

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
    this.resetSellArming();

    // TTL block with proper narrowing
    setTimeout(async () => {
      if (this.state !== "PENDING_ENTRY" || !this.entryOrderId) return;

      let st: OrderStatusRow | undefined = undefined;
      try { st = await getOrderStatus(this.entryOrderId); } catch {}

      const status = st?.status?.toUpperCase?.() || "UNKNOWN";
      const isPending = ["PENDING", "OPEN", "TRIGGER PENDING"].includes(status);
      const isFilled  = ["TRADED", "FILLED", "EXECUTED", "COMPLETED"].includes(status);

      if (isFilled) {
        this.log(`[ENTRY TTL] first order already filled (status=${status}) → LONG_ACTIVE, no re-place`);
        this.onEntryFilled();
        return;
      }
      if (st && !isPending && !isFilled) {
        this.log(`[ENTRY TTL] order not pending (status=${status}) → skipping re-place`);
        return;
      }

      this.log(`[ENTRY TTL] cancelling stale entry ${this.entryOrderId} and maybe re-placing...`);
      const cancelRes = await cancelOrderV3(this.entryOrderId);
      this.entryOrderId = undefined;

      if (isCancelOk(cancelRes)) {
        // Cancelled → safe to re-place
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
        return;
      }

      if (isCancelNotPending(cancelRes)) {
        // Not pending (likely filled) → mark filled
        this.log(`[ENTRY TTL] cancel says not pending (-52) → assume filled → LONG_ACTIVE, no re-place`);
        this.onEntryFilled();
        return;
      }

      // Any other error → safest is skip re-place
      this.log(`[ENTRY TTL] cancel error/unknown → skip re-place for safety`);
    }, ENTRY_TTL_MS);
  }

  public onEntryFilled() {
    if (this.state === "PENDING_ENTRY") {
      this.state = "LONG_ACTIVE";
      this.log(`[FILL] Entry filled → LONG_ACTIVE`);
    }
  }

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
  }

  private async onReentryDeadline() {
    this.log(`[REENTRY CHECK @60s] window expired, evaluating...`);
    this.reentryTimer = null;
    if (!this.reentryDeadline) return;

    if (this.state !== "IDLE") return;
    if (!this.stoppedOutDuringWindow) return;
    if (this.cancelReentryDueToSell) return;
    if (this.prevSavedLTP == null) return;

    const ltp = await this.ensureLTP();
    if (ltp > this.prevSavedLTP) {
      this.log(`[REENTRY OK] LTP ${ltp} > prev ${this.prevSavedLTP} → re-enter`);
      await this.enterLong(ltp);
    } else {
      this.log(`[REENTRY FAIL] LTP ${ltp} ≤ prev ${this.prevSavedLTP}`);
    }

    this.buySignalAt = null;
    this.reentryDeadline = null;
    this.cancelReentryDueToSell = false;
    this.stoppedOutDuringWindow = false;
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
    }
  }

  private resetSellArming() {
    this.sellArmed = false;
    this.sellArmRefLTP = null;
  }
}
