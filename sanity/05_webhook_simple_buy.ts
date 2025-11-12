// sanity/05_webhook_simple_buy.ts
import { http, log, delay } from "./_utils";

// Symbol like NIFTY251118C25650
const sym = process.argv[2] || process.env.SYM || "NIFTY251118C25650";

(async () => {
  const payload = `BUY ${sym}`;
  const r = await http("POST", "/webhook", payload, "text/plain");
  log("WEBHOOK BUY", r.json || r.text);
  await delay(500);
  const s = await http("GET", "/status");
  log("STATUS", s.json || s.text);
})();
