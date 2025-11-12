// sanity/08_poll_pnl.ts
import { http, log, delay } from "./_utils";

/** Poll /pnl five times and print totals and bySymbol rows. */
(async () => {
  for (let i = 0; i < 5; i++) {
    const r = await http("GET", "/pnl");
    const j = r.json || {};
    const by = j.pnl?.bySymbol || {};
    log("P&L TOTAL", { total: j.pnl?.total, realized: j.pnl?.realized, unrealized: j.pnl?.unrealized });
    const rows = Object.entries(by).map(([sym, v]: any) => ({
      sym,
      pos: v.posQty,
      avg: v.avgPrice,
      last: v.last,
      R: v.realized,
      U: v.unrealized,
    }));
    log("BY SYMBOL", rows);
    await delay(1000);
  }
})();
