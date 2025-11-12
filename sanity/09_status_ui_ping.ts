// sanity/09_status_ui_ping.ts
import { http, log } from "./_utils";

(async () => {
  const a = await http("GET", "/status-ui");
  const b = await http("GET", "/pnl-ui");
  log("STATUS-UI", { ok: a.ok, status: a.status, bytes: (a.text || "").length });
  log("PNL-UI", { ok: b.ok, status: b.status, bytes: (b.text || "").length });
})();
