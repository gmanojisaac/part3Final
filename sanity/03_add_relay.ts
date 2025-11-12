// sanity/03_add_relay.ts
import { http, log } from "./_utils";

// pass RELAY env or arg: npx ts-node sanity/03_add_relay.ts https://.../webhook
const argUrl = process.argv[2] || process.env.RELAY;
if (!argUrl) {
  log("USAGE", "RELAY=<url> npx ts-node sanity/03_add_relay.ts  OR  npx ts-node ... <url>");
  process.exit(1);
}

(async () => {
  const r = await http("POST", "/api/relays", { url: argUrl });
  log("ADD RELAY", r.json || r.text);
})();
