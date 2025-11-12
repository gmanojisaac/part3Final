// sanity/04_test_relay.ts
import { http, log } from "./_utils";

// optional: URL to test only one peer; otherwise tests all
const one = process.argv[2] || process.env.RELAY;

(async () => {
  const r = await http("POST", "/api/relays/test", { url: one, body: "TEST RELAY" });
  log("RELAY TEST", r.json || r.text);
})();
