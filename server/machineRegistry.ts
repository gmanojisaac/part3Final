import { TradeStateMachine } from "./stateMachine";

const machines = new Map<string, TradeStateMachine>(); // key: fyers symbol

export function upsertMachine(symbol: string, underlying: string) {
  if (!machines.has(symbol)) {
    machines.set(symbol, new TradeStateMachine({ symbol, underlying, slPoints: 0.5, orderValue: Number(process.env.ORDER_VALUE ?? 100000) }));
  }
  return machines.get(symbol)!;
}

export function getMachineBySymbol(symbol: string) {
  return machines.get(symbol);
}
