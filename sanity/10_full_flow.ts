// sanity/10_full_flow.ts
import { http, log, delay } from "./_utils";

/**
 * Full smoke test:
 *  - Add a (dummy) relay
 *  - Send rich ENTRY webhook (uses stopPx as seed if allowed)
 *  - Inject a tick (fallback if live mode without ALLOW_LTP_SEED)
 *  - Poll /status and /pnl
 *  - Remove the relay
 */
const relayUrl = process.argv[2] || process.env.RELAY || "https://example.com/webhook";
const sym = process.argv[3] || process.env.SYM || "NIFTY251118C25650";
const ltp = Number(process.argv[4] || process.env.LTP || 100);

(async () => {
  const add = await http("POST", "/api/relays", { url: relayUrl });
  log("ADD RELAY", add.json || add.text);

  const entry = `Accepted Entry + priorRisePct= 0.00 | stopPx=${ltp} | sym=${sym}`;
  const wh = await http("POST", "/webhook", entry, "text/plain");
  log("WEBHOOK ENTRY", wh.json || wh.text);

  // Fallback seeding if your handler is strict in live mode
  await delay(200);
  const fyers = (wh.json && wh.json.symbol) || "";
  if (fyers) {
    const inj = await http("GET", `/api/inject-tick?sym=${encodeURIComponent(fyers)}&ltp=${ltp}`);
    log("INJECT (fallback)", inj.json || inj.text);
  }

  await delay(300);
  const st = await http("GET", "/status");
  log("STATUS", st.json || st.text);

  const pn = await http("GET", "/pnl");
  log("PNL", pn.json || pn.text);

  const rm = await http("DELETE", "/api/relays", { url: relayUrl });
  log("REMOVE RELAY", rm.json || rm.text);
})();
