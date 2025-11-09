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
type WindowDir = "BUY" | "SELL" | null;

export interface MachineConfig {
  symbol: string;           // "NSE:NIFTY25N1125700CE"
  underlying: string;       // "NIFTY" | "BANKNIFTY"
  slPoints?: number;        // 0.5
  orderValue?: number;      // ₹1L
}

const ENTRY_TTL_MS = Number(process.env.ENTRY_TTL_MS ?? 15000);
const ENTRY_OFFSET  = Number(process.env.ENTRY_OFFSET  ?? 0.5); // Buy @ LTP+0.5
const EXIT_OFFSET   = Number(process.env.EXIT_OFFSET   ?? 0.5); // Sell @ LTP-0.5

export class TradeStateMachine {
  private readonly symbol: string;
  private readonly underlying: string;
  private readonly slPoints: number;
  private readonly orderValue: number;

  private state: State = "IDLE";
  private entryOrderId?: string;

  private savedBUYLTP: number | null = null;
  private savedSELLLTP: number | null = null;
  private entryRefLTP: number | null = null;

  private sellStartBuyAnchor: number | null = null;
  private pendingBuyAfterSell: boolean = false;
  private pendingBuyAnchor: number | null = null;

  private windowDir: WindowDir = null;
  private windowEndsAt: number | null = null;
  private windowExited: boolean = false;
  private buyWindowSilenced: boolean = false;
  private buyEntriesFilledThisWindow: number = 0;
  private buyWindowIndexSinceLastSell: number = 0;

  private exiting = false;
  private reentryTimer: NodeJS.Timeout | null = null;

  constructor(cfg: MachineConfig) {
    this.symbol = cfg.symbol;
    this.underlying = cfg.underlying.toUpperCase();
    this.slPoints = cfg.slPoints ?? 0.5;
    this.orderValue = cfg.orderValue ?? 100000;
    this.log(`[INIT] StateMachine created`);
    this.persist();
  }

  private log(msg: string) { console.log(`[${nowIST()}] [${this.symbol}] ${msg}`); }

  private persist() {
    const p: PersistedMachine & any = {
      symbol: this.symbol,
      underlying: this.underlying,
      state: this.state,
      prevSavedLTP: null,
      buySignalAt: null,
      reentryDeadline: this.windowEndsAt,
      rollingActive: false,
      cancelReentryDueToSell: false,
      sellArmed: false,
      sellArmRefLTP: null,
      entryOrderId: this.entryOrderId,
      entryRefLTP: this.entryRefLTP,
      slPoints: this.slPoints,
      orderValue: this.orderValue,

      savedBUYLTP: this.savedBUYLTP,
      savedSELLLTP: this.savedSELLLTP,
      windowDir: this.windowDir,
      windowEndsAt: this.windowEndsAt,
      windowExited: this.windowExited,
      buyEntriesFilledThisWindow: this.buyEntriesFilledThisWindow,
      buyWindowSilenced: this.buyWindowSilenced,
      sellStartBuyAnchor: this.sellStartBuyAnchor,
      pendingBuyAfterSell: this.pendingBuyAfterSell,
      pendingBuyAnchor: this.pendingBuyAnchor,
      buyWindowIndexSinceLastSell: this.buyWindowIndexSinceLastSell,
    };
    upsert(p);
  }

  public static fromPersisted(p: PersistedMachine & any) {
    const m = new TradeStateMachine({
      symbol: p.symbol,
      underlying: p.underlying,
      slPoints: p.slPoints,
      orderValue: p.orderValue,
    });
    (m as any).state = p.state;
    (m as any).entryOrderId = p.entryOrderId;
    (m as any).entryRefLTP = p.entryRefLTP;

    (m as any).savedBUYLTP = p.savedBUYLTP ?? null;
    (m as any).savedSELLLTP = p.savedSELLLTP ?? null;

    (m as any).windowDir = p.windowDir ?? null;
    (m as any).windowEndsAt = p.windowEndsAt ?? null;
    (m as any).windowExited = p.windowExited ?? false;
    (m as any).buyEntriesFilledThisWindow = p.buyEntriesFilledThisWindow ?? 0;
    (m as any).buyWindowSilenced = p.buyWindowSilenced ?? false;

    (m as any).sellStartBuyAnchor = p.sellStartBuyAnchor ?? null;
    (m as any).pendingBuyAfterSell = p.pendingBuyAfterSell ?? false;
    (m as any).pendingBuyAnchor = p.pendingBuyAnchor ?? null;
    (m as any).buyWindowIndexSinceLastSell = p.buyWindowIndexSinceLastSell ?? 0;

    m.log(`[RESUME] state=${p.state}, window=${(m as any).windowDir ?? "NONE"} exitsUsed=${(m as any).windowExited ? 1 : 0}, buyIdx=${(m as any).buyWindowIndexSinceLastSell}`);
    m.persist();
    return m;
  }

  getState() { return this.state; }

  async onSignal(sig: Signal, ltpHint?: number) {
    const ltp = await this.ensureLTP(ltpHint);
    this.log(`Signal: ${sig} @ LTP=${ltp.toFixed(2)} | state=${this.state}`);
    if (sig === "BUY_SIGNAL") return this.onBuySignal(ltp);
    if (sig === "SELL_SIGNAL") return this.onSellSignal(ltp);
  }

  async onTick(ltp: number) {
    // BUY window logic (with subsequent window silencing rule)
    if (this.windowDir === "BUY" && this.isWindowActive()) {
      if (this.buyWindowSilenced) return;

      if (!this.exiting && !this.windowExited && this.state === "LONG_ACTIVE") {
        const firstEntry = this.buyEntriesFilledThisWindow <= 1;
        const stopThresh = firstEntry ? (this.savedBUYLTP! - this.slPoints) : (this.savedBUYLTP!);
        if (ltp <= stopThresh) {
          this.exiting = true;
          this.log(`[BUY-WINDOW STOP] ltp=${ltp.toFixed(2)} <= ${stopThresh.toFixed(2)} → exit & consume window`);
          await this.exitLong("BUY_WINDOW_STOP", ltp);
          this.windowExited = true;
          this.exiting = false;
          this.persist();
          return;
        }
      }

      if (!this.windowExited && this.state === "IDLE") {
        if (ltp > (this.savedBUYLTP ?? Number.POSITIVE_INFINITY - 1)) {
          await this.enterLong(ltp);
        }
      }

      // Subsequent BUY windows (after first SELL): silence if price < sellStartBuyAnchor
      if (this.buyWindowIndexSinceLastSell >= 2 && this.sellStartBuyAnchor != null) {
        if (ltp < this.sellStartBuyAnchor) {
          this.savedBUYLTP = this.sellStartBuyAnchor;
          this.pendingBuyAfterSell = false;
          this.buyWindowSilenced = true;
          this.log(`[BUY WINDOW SILENCE] ltp ${ltp.toFixed(2)} < sellStartBuyAnchor ${this.sellStartBuyAnchor.toFixed(2)} → savedBUYLTP=${this.savedBUYLTP.toFixed(2)}; silence until window ends`);
          this.persist();
          return;
        }
      }
    }

    // SELL window is passive during ticks (we defer BUY switch to window end)
  }

  // ---- Signals
  private async onBuySignal(ltp: number) {
    // First BUY after SELL: clear pending flag; set anchor if missing
    this.pendingBuyAfterSell = false;
    if (this.sellStartBuyAnchor == null) this.sellStartBuyAnchor = ltp;

    await this.startBuyWindow(ltp);
  }

  private async onSellSignal(ltp: number) {
    this.closeWindow();
    this.windowDir = "SELL";
    this.windowEndsAt = Date.now() + 60_000;
    this.windowExited = false;

    this.sellStartBuyAnchor = ltp;
    this.savedSELLLTP = ltp;

    this.pendingBuyAfterSell = true;
    this.pendingBuyAnchor = ltp;

    this.buyWindowIndexSinceLastSell = 0;

    this.log(
      `[SELL WINDOW] start 60s until ${new Date(this.windowEndsAt).toLocaleTimeString("en-GB",{ timeZone: "Asia/Kolkata" })} | anchor=${ltp.toFixed(2)} (BUY deferred to end)`
    );

    // Immediate exit if in trade, but stay in SELL window
    if (this.state === "LONG_ACTIVE" || this.state === "PENDING_ENTRY") {
      this.log(`[SELL WINDOW] active position → immediate exit @ (ltp-0.5); BUY window will start after SELL window ends`);
      await this.exitLong("SELL_WINDOW_IMMEDIATE_EXIT", ltp);
    }

    this.armWindowTimer();
    this.persist();
  }

  // ---- BUY window creation
  private async startBuyWindow(anchorLtp: number) {
    this.closeWindow();
    this.windowDir = "BUY";
    this.windowEndsAt = Date.now() + 60_000;
    this.windowExited = false;
    this.buyEntriesFilledThisWindow = 0;
    this.buyWindowSilenced = false;
    this.savedBUYLTP = anchorLtp;

    this.buyWindowIndexSinceLastSell += 1;

    this.log(
      `[BUY WINDOW] start 60s (idx=${this.buyWindowIndexSinceLastSell}) until ${new Date(this.windowEndsAt).toLocaleTimeString("en-GB",{ timeZone: "Asia/Kolkata" })} | savedBUYLTP=${anchorLtp.toFixed(2)}`
    );

    if (this.state === "IDLE") {
      await this.enterLong(anchorLtp);
    }

    this.armWindowTimer();
    this.persist();
  }

  // ---- Orders
  private async enterLong(ltp: number) {
    if (!this.isWindowActive()) { this.log(`[ENTER LONG] blocked — no active window`); return; }
    if (this.windowExited) { this.log(`[ENTER LONG] blocked — window exit already consumed`); return; }
    if (this.windowDir === "BUY" && this.buyWindowSilenced) { this.log(`[ENTER LONG] blocked — BUY window silenced`); return; }
    if (this.state !== "IDLE") { this.log(`[ENTER LONG] ignored — state=${this.state}`); return; }

    const qty = calculateQuantityForOrderValue(this.underlying, ltp, this.orderValue);
    this.entryRefLTP = ltp;
    const buyLimit = roundToTick(ltp + ENTRY_OFFSET);
    this.log(`[ENTER LONG] window=${this.windowDir} nextFill=${this.buyEntriesFilledThisWindow + 1} qty=${qty}, LIMIT=${buyLimit}, LTP=${ltp}`);

    const entry = await placeLimitOrderV3({
      symbol: this.symbol,
      side: "BUY",
      qty,
      limitPrice: buyLimit,
      productType: "INTRADAY",
      validity: "DAY",
    });

    this.entryOrderId = entry?.id;
    this.state = "PENDING_ENTRY";
    this.persist();

    setTimeout(async () => {
      if (this.state !== "PENDING_ENTRY" || !this.entryOrderId) return;

      if (!this.isWindowActive() || this.windowExited || (this.windowDir === "BUY" && this.buyWindowSilenced)) {
        this.log(`[ENTRY TTL] window not active/consumed/silenced → cancel pending and stop`);
        await cancelOrderV3(this.entryOrderId);
        this.entryOrderId = undefined;
        this.state = "IDLE";
        this.persist();
        return;
      }

      try {
        const st = await getOrderStatusV3(this.entryOrderId);
        if (st.found && !isOrderPending(st.status)) {
          this.log(`[ENTRY TTL] status=${st.status} → no re-place`);
          if (String(st.status).toUpperCase() === "FILLED") this.onEntryFilled();
          return;
        }
      } catch {}

      this.log(`[ENTRY TTL] cancelling stale entry ${this.entryOrderId} and (maybe) re-placing...`);
      const cancelRes: any = await cancelOrderV3(this.entryOrderId);
      const notPending = cancelRes?.code === -52;
      if (notPending) {
        this.log(`[ENTRY TTL] cancel says not pending → skip re-place`);
        return;
      }
      this.entryOrderId = undefined;

      if (!this.isWindowActive() || this.windowExited || (this.windowDir === "BUY" && this.buyWindowSilenced)) {
        this.log(`[ENTRY TTL] window changed/consumed/silenced → skip re-place`);
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
      this.buyEntriesFilledThisWindow += 1;
      this.log(`[FILL] Entry filled → LONG_ACTIVE (fills this window=${this.buyEntriesFilledThisWindow})`);
      this.persist();
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
    this.entryRefLTP = null;
    this.state = "IDLE";
    this.persist();
  }

  // ---- window helpers
  private armWindowTimer() {
    if (this.reentryTimer) clearTimeout(this.reentryTimer);
    const ms = Math.max(0, (this.windowEndsAt ?? Date.now()) - Date.now());
    this.reentryTimer = setTimeout(() => this.onWindowEnd(), ms);
  }

  private async onWindowEnd() {
    this.reentryTimer = null;
    const endedDir = this.windowDir;
    this.log(`[WINDOW END] ${endedDir ?? "NONE"} window ended`);

    // SELL → deferred BUY
    if (endedDir === "SELL" && this.pendingBuyAfterSell && this.pendingBuyAnchor != null) {
      const anchor = this.pendingBuyAnchor;
      this.pendingBuyAfterSell = false;
      this.pendingBuyAnchor = null;
      await this.startBuyWindow(anchor);
      return;
    }

    // BUY window ended while silenced → auto new BUY window with current savedBUYLTP
    if (endedDir === "BUY" && this.buyWindowSilenced) {
      const anchor = this.savedBUYLTP ?? (await this.ensureLTP());
      this.buyWindowSilenced = false;
      await this.startBuyWindow(anchor);
      return;
    }

    this.closeWindow();
    this.persist();
  }

  private closeWindow() {
    this.windowDir = null;
    this.windowEndsAt = null;
    this.windowExited = false;
    this.buyEntriesFilledThisWindow = 0;
    if (this.reentryTimer) clearTimeout(this.reentryTimer);
    this.reentryTimer = null;
  }

  private isWindowActive() {
    return this.windowDir != null && this.windowEndsAt != null && Date.now() <= this.windowEndsAt;
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
}
