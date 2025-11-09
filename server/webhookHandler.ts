// server/webhookHandler.ts
import { parseWebhookSym } from "./symbolFormat";
import { TradeStateMachine } from "./stateMachine";
import { dataSocket } from "./dataSocket";

/** Keep one machine per FYERS symbol */
const machines = new Map<string, TradeStateMachine>();

function getOrCreateMachine(fyersSymbol: string, underlying: string) {
  let m = machines.get(fyersSymbol);
  if (!m) {
    m = new TradeStateMachine({
      symbol: fyersSymbol,
      underlying,
      orderValue: 100000,
      slPoints: 0.5,
    });
    machines.set(fyersSymbol, m);
    console.log(`[INIT] machine for ${fyersSymbol}`);
  }
  return m;
}

/**
 * Handle incoming text payloads from /webhook.
 * Examples:
 *   "BUY NIFTY251111C25000"
 *   "SELL BANKNIFTY251125P49500"
 */
export async function handleWebhookText(bodyText: string) {
  const text = (bodyText || "").trim();
  if (!text) throw new Error("Empty webhook body");

  const upper = text.toUpperCase();
  const isBuy = /\bBUY\b/.test(upper);
  const isSell = /\bSELL\b/.test(upper);
  const symMatch = upper.match(/\b(NIFTY|BANKNIFTY)\d{6}[CP]\d+\b/);

  if (!symMatch || (!isBuy && !isSell)) {
    throw new Error(`Cannot parse webhook: ${bodyText}`);
  }

  const rawSym = symMatch[0];
  const { fyers, underlying } = parseWebhookSym(rawSym);

  // Ensure subscription for ticks
  await dataSocket.subscribe(fyers);

  // Route signal to the state machine
  const m = getOrCreateMachine(fyers, underlying);
  if (isBuy) {
    await m.onSignal("BUY_SIGNAL");
  } else if (isSell) {
    await m.onSignal("SELL_SIGNAL");
  }

  return {
    ok: true,
    symbol: fyers,
    action: isBuy ? "BUY_SIGNAL" : "SELL_SIGNAL",
    state: (m as any).getState ? (m as any).getState() : undefined,
  };
}
