// sanity/06_webhook_rich_entry_exit.ts
import { http, log, delay } from "./_utils";

/**
 * Sends a rich "Accepted Entry ..." and then a rich "Accepted Exit ..."
 * To let this work in LIVE mode without data feed, set:
 *   ALLOW_LTP_SEED=true
 * or inject ticks with script 07.
 */
const entrySym = process.argv[2] || process.env.SYM || "NIFTY251118C25650";
const seedPx = Number(process.argv[3] || process.env.SEED || 100);

(async () => {
  const entry = `Accepted Entry + priorRisePct= 0.00 | stopPx=${seedPx} | sym=${entrySym}`;
  const r1 = await http("POST", "/webhook", entry, "text/plain");
  log("ENTRY", r1.json || r1.text);

  // optional: send an exit on another symbol (or same)
  const exitSym = process.argv[4] || process.env.SYM2 || entrySym.replace("C", "P");
  const r2 = await http(
    "POST",
    "/webhook",
    `Accepted Exit + priorRisePct= 0.05 | stopPx=${seedPx * 1.1} | sym=${exitSym}`,
    "text/plain"
  );
  log("EXIT", r2.json || r2.text);

  await delay(500);
  const s = await http("GET", "/status");
  log("STATUS", s.json || s.text);
})();
