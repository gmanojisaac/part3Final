// server/webhookHandler.ts
import { dataSocket } from "./dataSocket";
import { TradeStateMachine } from "./stateMachine";
import { parseWebhookSym } from "./symbolFormat";
import { getQuotesV3, isPaper } from "./fyersClient";

/** One machine per FYERS symbol */
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

/** Try to extract a normalized { side, rawSymbol, seedPx? } from arbitrary text */
function parseSideSymAndSeed(
  raw: string
): { side: "BUY" | "SELL"; rawSymbol: string; seedPx?: number } | null {
  const txt = raw.trim().toUpperCase();

  // --- Path A: "BUY <SYMBOL>" / "SELL <SYMBOL>" ---
  const simple = txt.match(/\b(BUY|SELL)\s+([A-Z]+(?:NIFTY)?\d{6}[CP]\d+)\b/);
  if (simple) {
    const side = simple[1] as "BUY" | "SELL";
    const rawSymbol = simple[2];
    return { side, rawSymbol };
  }

  // --- Path B: "Accepted Entry/Exit ... | sym=<SYMBOL>" (or sym: <SYMBOL>) ---
  const isEntry = /\bENTRY\b/.test(txt);
  const isExit = /\bEXIT\b/.test(txt);
  const side: "BUY" | "SELL" | null = isEntry ? "BUY" : isExit ? "SELL" : null;

  // Symbol
  const symMatch =
    txt.match(/\bsym\s*=\s*([A-Z]+(?:NIFTY)?\d{6}[CP]\d+)\b/) ||
    txt.match(/\bsym\s*:\s*([A-Z]+(?:NIFTY)?\d{6}[CP]\d+)\b/);

  // Optional seed price (e.g. "stopPx=218.35")
  const stopPxMatch = txt.match(/\bstoppx\s*=\s*([0-9]+(?:\.[0-9]+)?)\b/i);
  const seedPx = stopPxMatch ? Number(stopPxMatch[1]) : undefined;

  if (side && symMatch) {
    return { side, rawSymbol: symMatch[1], seedPx };
  }

  // --- Path C: generic scan for any option-like token if side present somewhere ---
  const token = txt.match(/\b([A-Z]+(?:NIFTY)?\d{6}[CP]\d+)\b/);
  if (token && side) {
    return { side, rawSymbol: token[1], seedPx };
  }

  return null;
}

/** Poll the quote cache for up to `timeoutMs` until we get an LTP */
async function waitForLTP(symbol: string, timeoutMs = 2000): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const q = await getQuotesV3(symbol);
    const lp = (q as any)?.d?.[0]?.v?.lp ?? null;
    if (lp != null) return lp;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/**
 * Handle incoming text payloads from /webhook.
 * Supports:
 *   - "BUY NIFTY251111C25000"
 *   - "SELL BANKNIFTY251125P49500"
 *   - "Accepted Entry + priorFallPct=... | stopPx=... | sym=NIFTY251111P25550"
 *   - "Accepted Exit + ... | sym=..."
 */
export async function handleWebhookText(bodyText: string) {
  const text = (bodyText || "").trim();
  if (!text) throw new Error("Empty webhook body");

  console.log(`[webhookHandler] Received: ${text}`);

  const parsed = parseSideSymAndSeed(text);
  if (!parsed) {
    throw new Error(`Cannot parse webhook: ${bodyText}`);
  }

  const { side, rawSymbol, seedPx } = parsed;

  // Convert to FYERS symbol and get underlying
  const { fyers, underlying } = parseWebhookSym(rawSymbol);
  console.log(`[webhookHandler] side=${side}, symbol=${rawSymbol} → ${fyers}`);

  // Ensure market data subscription
  await dataSocket.subscribe(fyers);

  // In PAPERTRADE, if we have a seed price and no LTP yet, inject a seed tick to start the engine
  if (isPaper() && seedPx != null) {
    // this will also update the quote cache via onTickFromMarket()
    dataSocket.injectTick(fyers, seedPx, Date.now());
  }

  // Wait a bit for LTP to arrive so stateMachine.ensureLTP won't throw
  const ltp = await waitForLTP(fyers, 2000);
  if (ltp == null) {
    // Keep explicit behavior: fail if no LTP (most likely live feed not wired yet)
    throw new Error(`LTP not found for ${fyers}`);
  }

  // Route signal to state machine
  const m = getOrCreateMachine(fyers, underlying);
  if (side === "BUY") {
    await m.onSignal("BUY_SIGNAL");
  } else {
    await m.onSignal("SELL_SIGNAL");
  }

  return {
    ok: true,
    symbol: fyers,
    action: side === "BUY" ? "BUY_SIGNAL" : "SELL_SIGNAL",
    ltp,
    state: (m as any).getState ? (m as any).getState() : undefined,
  };
}
