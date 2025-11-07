import { StateMachine } from "./stateMachine";
import { Tick, Trade } from "./types";

export type RunSummary = {
  trades: Trade[];
  bySymbol: Record<string, { pnl: number; trades: number }>;
  totalPnl: number;
};

/** Replay ticks through the state machine and compute P&L. */
export function runSimulation(
  ticks: Tick[],
  opts?: { qty?: number; cooldownSecs?: number }
): RunSummary {
  const sm = new StateMachine({ qty: opts?.qty, cooldownSecs: opts?.cooldownSecs });
  const trades: Trade[] = [];

  sm.onEvent((e) => {
    if (e.type === "entered") {
      console.log(
        `[ENTER] ${e.trade.symbol} qty=${e.trade.entry.qty} @ ${e.trade.entry.price} ${e.trade.entry.time.toISOString()}`
      );
    } else if (e.type === "exited" || e.type === "stop-loss") {
      const t = e.trade;
      trades.push(t);
      console.log(
        `[EXIT-${t.reason}] ${t.symbol} @ ${t.exit!.price} pnl=${t.pnl?.toFixed(2)} ${t.exit!.time.toISOString()}`
      );
    } else if (e.type === "cooldown-enter") {
      console.log(
        `[COOLDOWN] ${e.symbol} until=${e.until.toISOString()} prevSavedLTP=${e.prevSavedLTP}`
      );
    } else if (e.type === "cooldown-extend") {
      console.log(`[COOLDOWN-EXTEND] ${e.symbol} until=${e.until.toISOString()}`);
    } else if (e.type === "cooldown-exit") {
      console.log(`[COOLDOWN-EXIT] ${e.symbol}`);
    }
  });

  ticks.sort((a, b) => a.time.getTime() - b.time.getTime());
  for (const t of ticks) sm.feed(t);

  const bySymbol: RunSummary["bySymbol"] = {};
  for (const tr of trades) {
    bySymbol[tr.symbol] ??= { pnl: 0, trades: 0 };
    bySymbol[tr.symbol].pnl += tr.pnl ?? 0;
    bySymbol[tr.symbol].trades += 1;
  }
  const totalPnl = Object.values(bySymbol).reduce((s, x) => s + x.pnl, 0);
  return { trades, bySymbol, totalPnl };
}
