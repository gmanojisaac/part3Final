// sanity/07_inject_tick.ts
import { http, log } from "./_utils";

/**
 * Prime the quote cache manually.
 * Usage:
 *   npx ts-node sanity/07_inject_tick.ts NSE:NIFTY25N1825650CE 100
 */
const sym = process.argv[2] || process.env.FYERS || "";
const ltp = Number(process.argv[3] || process.env.LTP || NaN);

if (!sym || !Number.isFinite(ltp)) {
  log("USAGE", "npx ts-node sanity/07_inject_tick.ts <FYERS_SYMBOL> <LTP>");
  process.exit(1);
}

(async () => {
  const q = await http("GET", `/api/inject-tick?sym=${encodeURIComponent(sym)}&ltp=${ltp}`);
  log("INJECT", q.json || q.text);
})();
