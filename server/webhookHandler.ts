// server/webhookHandler.ts
import { dataSocket } from "./dataSocket";
import { TradeStateMachine } from "./stateMachine";
import { parseWebhookSym } from "./symbolFormat";
import { getQuotesV3, isPaper } from "./fyersClient";
import { isMarketOpen, marketClock } from "./marketHours";

/** One machine per FYERS symbol */
const machines = new Map<string, TradeStateMachine>();

function getOrCreateMachine(fyersSymbol: string, underlying: string) {
  let m = machines.get(fyersSymbol);
  if (!m) {
    m = new TradeStateMachine({
      symbol: fyersSymbol,
      underlying,
      orderValue: Number(process.env.ORDER_VALUE || 100000),
      slPoints: Number(process.env.SL_POINTS || 0.5),
    });
    machines.set(fyersSymbol, m);
    console.log(`[INIT] machine for ${fyersSymbol}`);
  }
  return m;
}

/** Parse side + symbol (+ optional seed price from stopPx or '@ price') */
function parseSideSymAndSeed(
  raw: string
): { side: "BUY" | "SELL"; rawSymbol: string; seedPx?: number } | null {
  const txt = raw.trim().toUpperCase();

  // "BUY <SYMBOL> @ <PRICE>"
  {
    const m = txt.match(/\b(BUY|SELL)\s+([A-Z]+(?:NIFTY)?\d{6}[CP]\d+)\s*@\s*([0-9]+(?:\.[0-9]+)?)\b/);
    if (m) return { side: m[1] as "BUY" | "SELL", rawSymbol: m[2], seedPx: Number(m[3]) };
  }
  // "BUY <SYMBOL>" / "SELL <SYMBOL>"
  {
    const m = txt.match(/\b(BUY|SELL)\s+([A-Z]+(?:NIFTY)?\d{6}[CP]\d+)\b/);
    if (m) return { side: m[1] as "BUY" | "SELL", rawSymbol: m[2] };
  }
  // Rich format: ... | sym=...  + optional stopPx=
  const isEntry = /\bENTRY\b/.test(txt);
  const isExit = /\bEXIT\b/.test(txt);
  const side: "BUY" | "SELL" | null = isEntry ? "BUY" : isExit ? "SELL" : null;
  const symMatch =
    txt.match(/\bsym\s*=\s*([A-Z]+(?:NIFTY)?\d{6}[CP]\d+)\b/) ||
    txt.match(/\bsym\s*:\s*([A-Z]+(?:NIFTY)?\d{6}[CP]\d+)\b/);
  const stopPxMatch = txt.match(/\bstoppx\s*=\s*([0-9]+(?:\.[0-9]+)?)\b/i);
  const seedPx = stopPxMatch ? Number(stopPxMatch[1]) : undefined;
  if (side && symMatch) return { side, rawSymbol: symMatch[1], seedPx };
  const token = txt.match(/\b([A-Z]+(?:NIFTY)?\d{6}[CP]\d+)\b/);
  if (token && side) return { side, rawSymbol: token[1], seedPx };

  return null;
}

/** Wait for a fresh LTP that arrived *after* subscribeTs (i.e., from live feed) */
async function waitForFreshLTP(symbol: string, subscribeTs: number, timeoutMs: number): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const q = await getQuotesV3(symbol);
    const lp = (q as any)?.d?.[0]?.v?.lp ?? null;
    const ts = (q as any)?.d?.[0]?.v?.tt ?? (q as any)?.ts ?? null;
    if (lp != null && ts != null && Number(ts) >= subscribeTs) return lp as number;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** Handle incoming text payloads (simple + '@ price' + rich) */
export async function handleWebhookText(bodyText: string) {
  const text = (bodyText || "").trim();
  if (!text) throw new Error("Empty webhook body");

  console.log(`[webhookHandler] Received: ${text}`);

  const parsed = parseSideSymAndSeed(text);
  if (!parsed) throw new Error(`Cannot parse webhook: ${bodyText}`);

  // ---- MARKET WINDOW GUARD ----
  const allowAfterHours = (process.env.ALLOW_AFTER_HOURS || "").toLowerCase() === "true";
  const clock = marketClock();
  if (!allowAfterHours && !isMarketOpen()) {
    return {
      ok: false,
      ignored: true,
      reason: "Market closed",
      clock,
      hint: "Set ALLOW_AFTER_HOURS=true to bypass this gate (for testing).",
    };
  }

  const { side, rawSymbol } = parsed; // we will NOT seed for entries here
  const { fyers, underlying } = parseWebhookSym(rawSymbol);
  console.log(`[webhookHandler] side=${side}, symbol=${rawSymbol} → ${fyers}`);

  // Subscribe and wait for a fresh tick from live socket
  const subscribeTs = Date.now();
  await dataSocket.subscribe(fyers);

  const timeoutMs = Number(process.env.LTP_WAIT_MS || 3000);
  const ltp = await waitForFreshLTP(fyers, subscribeTs, timeoutMs);
  if (ltp == null) {
    throw new Error(`LTP not found for ${fyers} within ${timeoutMs}ms (waiting for live tick).`);
  }

  // Route to state machine
  const m = getOrCreateMachine(fyers, underlying);
  if (side === "BUY") await m.onSignal("BUY_SIGNAL");
  else await m.onSignal("SELL_SIGNAL");

  return {
    ok: true,
    symbol: fyers,
    action: side === "BUY" ? "BUY_SIGNAL" : "SELL_SIGNAL",
    ltp,
    clock,
    state: (m as any).getState ? (m as any).getState() : undefined,
  };
}
