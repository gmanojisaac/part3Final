// sanity/02_status.ts
import { http, log } from "./_utils";

(async () => {
  const r = await http("GET", "/status");
  if (!r.ok) {
    log("STATUS FAIL", { code: r.status, body: r.text });
    process.exit(1);
  }
  log("STATUS OK", r.json);
})();
