// server/index.ts
// ---------------------------------------------------------------------------
// Load environment variables before anything else
// ---------------------------------------------------------------------------
import "dotenv/config";

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import express, { type Request, type Response } from "express";
import bodyParser from "body-parser";

import { handleWebhookText, webhookStatus } from "./webhookHandler";
import { connect as connectDataSocket } from "./dataSocket"; // ensures sockets get initialized
import { getPnL, getTrades, isPaper } from "./fyersClient";
import { marketClock } from "./marketHours";
import { getRelays, relayToAll } from "./relayStore";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const app = express();
const PORT = Number(process.env.PORT ?? 2000);

// We want to be able to accept plain-text webhooks easily.
app.use(bodyParser.text({ type: "*/*" }));

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
app.get("/", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html>
  <head>
    <title>Engine</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 16px; }
      a { color: #0b7285; text-decoration: none; }
      a:hover { text-decoration: underline; }
      ul { line-height: 1.6; }
    </style>
  </head>
  <body>
    <h1>Automated BOT – Server</h1>
    <ul>
      <li><a href="/status-ui">Status UI</a></li>
      <li><a href="/pnl-ui">PnL UI</a></li>
      <li><a href="/relays-ui">Relays UI</a></li>
    </ul>
  </body>
</html>`);
});

// ---------------------------------------------------------------------------
// Webhook endpoint
// ---------------------------------------------------------------------------
app.post("/webhook", async (req: Request, res: Response) => {
  const raw = typeof req.body === "string" ? req.body : "";
  try {
    const result = await handleWebhookText(raw);
    res.json({ ok: true, result });
  } catch (err: any) {
    console.error("[/webhook] ERROR:", err);
    res.status(500).json({ ok: false, error: err?.message ?? String(err) });
  }
});

// ---------------------------------------------------------------------------
// JSON APIs
// ---------------------------------------------------------------------------

// Engine / market status
app.get("/status", (_req: Request, res: Response) => {
  res.json(webhookStatus());
});

// PnL snapshot (used by /pnl-ui)
app.get("/pnl", (_req: Request, res: Response) => {
  const pnl = getPnL();
  const trades = getTrades();

  // Flatten bySymbol into an array of "positions" for UI convenience
  const positions = Object.entries(pnl.bySymbol).map(([symbol, row]) => ({
    symbol,
    qty: row.posQty,
    avgPrice: row.avgPrice,
    ltp: row.ltp,
    unrealized: row.unrealized,
    realized: row.realized,
    brokerage: row.brokerage,
    grossRealized: row.grossRealized,
  }));

  res.json({
    realized: pnl.realized,
    unrealized: pnl.unrealized,
    total: pnl.total,
    brokerage: pnl.brokerage,
    grossRealized: pnl.grossRealized,
    positions,
    trades,
  });
});

// Relay list
app.get("/relays", (_req: Request, res: Response) => {
  res.json({ relays: getRelays() });
});

// Relay-test helper: broadcast given body to all relays
app.post("/relay-test", async (req: Request, res: Response) => {
  const payload = typeof req.body === "string" ? req.body : String(req.body ?? "");
  try {
    const result = await relayToAll(payload);
    res.json({ ok: true, result });
  } catch (err: any) {
    console.error("[/relay-test] ERROR:", err);
    res.status(500).json({ ok: false, error: err?.message ?? String(err) });
  }
});

// ---------------------------------------------------------------------------
// HTML UIs
// ---------------------------------------------------------------------------

// Status UI
app.get("/status-ui", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html>
  <head>
    <title>Status</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 16px; }
      table { border-collapse: collapse; margin-top: 12px; }
      th, td { padding: 4px 8px; border: 1px solid #ccc; font-size: 13px; }
      .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
      .ok { background: #d3f9d8; color: #2b8a3e; }
      .bad { background: #ffe3e3; color: #c92a2a; }
      .muted { color: #555; font-size: 12px; }
    </style>
  </head>
  <body>
    <h1>Webhook / Engine Status</h1>
    <div id="status"></div>
    <div class="muted">Auto-refreshes every 5 seconds.</div>

    <script>
      async function refresh() {
        try {
          const res = await fetch('/status');
          const data = await res.json();

          const rows = [];
          rows.push('<tr><th>Paper</th><td>' + (data.paper ? 'YES' : 'NO') + '</td></tr>');
          rows.push('<tr><th>Market Open (clock)</th><td>' + (data.nowOpen ? 'YES' : 'NO') + '</td></tr>');
          rows.push('<tr><th>Market Open (rule)</th><td>' + (data.marketOpen ? 'YES' : 'NO') + '</td></tr>');

          const html = '<table>' + rows.join('') + '</table>';
          document.getElementById('status').innerHTML = html;
        } catch (e) {
          document.getElementById('status').textContent = 'Error loading /status: ' + e;
        }
      }

      refresh();
      setInterval(refresh, 5000);
    </script>
  </body>
</html>`);
});

// PnL UI – no raw JSON, only tables with 2-decimal fields
app.get("/pnl-ui", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html>
  <head>
    <title>PnL</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 16px; }
      h1 { margin-bottom: 8px; }
      h2 { margin-top: 24px; margin-bottom: 8px; font-size: 16px; }
      table { border-collapse: collapse; margin-top: 8px; width: 100%; max-width: 900px; }
      th, td { padding: 4px 8px; border: 1px solid #ccc; font-size: 12px; text-align: right; }
      th:first-child, td:first-child { text-align: left; }
      .pos { color: #2b8a3e; }
      .neg { color: #c92a2a; }
      .muted { color: #555; font-size: 12px; margin-top: 4px; }
    </style>
  </head>
  <body>
    <h1>PnL Snapshot</h1>
    <div id="summary"></div>
    <h2>Trades</h2>
    <div id="trades"></div>
    <div class="muted">Auto-refreshes every 3 seconds.</div>

    <script>
      function fmt2(x) {
        if (x == null || isNaN(x)) return '-';
        return Number(x).toFixed(2);
      }

      function cls(x) {
        if (x > 0) return 'pos';
        if (x < 0) return 'neg';
        return '';
      }

      function fmtTime(ts) {
        const d = new Date(ts);
        const time = d.toLocaleTimeString('en-GB', { hour12: false });
        const date = d.toLocaleDateString('en-GB'); // dd/mm/yyyy
        return time + ' ' + date.replace(/\\//g, '/');
      }

      async function refresh() {
        try {
          const res = await fetch('/pnl');
          const data = await res.json();

          // --- Summary table ---
          const total = data.total || 0;
          const realized = data.realized || 0;
          const unrealized = data.unrealized || 0;
          const brokerage = data.brokerage || 0;

          let summaryHtml = '<table>';
          summaryHtml += '<thead><tr><th>Metric</th><th>Value</th></tr></thead>';
          summaryHtml += '<tbody>';
          summaryHtml += '<tr><td>Total P&L</td><td class="' + cls(total) + '">' + fmt2(total) + '</td></tr>';
          summaryHtml += '<tr><td>Realized P&L</td><td class="' + cls(realized) + '">' + fmt2(realized) + '</td></tr>';
          summaryHtml += '<tr><td>Unrealized P&L</td><td class="' + cls(unrealized) + '">' + fmt2(unrealized) + '</td></tr>';
          summaryHtml += '<tr><td>Brokerage (10% of profit)</td><td class="' + cls(brokerage) + '">' + fmt2(brokerage) + '</td></tr>';
          summaryHtml += '</tbody></table>';
          document.getElementById('summary').innerHTML = summaryHtml;

          // --- Trades table ---
          const trades = Array.isArray(data.trades) ? data.trades.slice().sort((a, b) => b.ts - a.ts) : [];
          const rows = [];
          for (const t of trades) {
            const pnl = t.realized || 0;
            rows.push(
              '<tr>' +
                '<td>' + fmtTime(t.ts) + '</td>' +
                '<td>' + (t.symbol || '') + '</td>' +
                '<td>' + (t.side || '') + '</td>' +
                '<td>' + (t.qty || 0) + '</td>' +
                '<td>' + fmt2(t.price) + '</td>' +
                '<td class="' + cls(pnl) + '">' + fmt2(pnl) + '</td>' +
              '</tr>'
            );
          }

          let tradesHtml = '<table>';
          tradesHtml += '<thead><tr>' +
            '<th>Time</th>' +
            '<th>Symbol</th>' +
            '<th>Side</th>' +
            '<th>Qty</th>' +
            '<th>Price</th>' +
            '<th>P&L</th>' +
          '</tr></thead>';
          tradesHtml += '<tbody>' + (rows.join('') || '<tr><td colspan="6" style="text-align:center;">No trades yet.</td></tr>') + '</tbody>';
          tradesHtml += '</table>';

          document.getElementById('trades').innerHTML = tradesHtml;
        } catch (e) {
          document.getElementById('summary').textContent = 'Error loading /pnl: ' + e;
          document.getElementById('trades').textContent = '';
        }
      }

      refresh();
      setInterval(refresh, 3000);
    </script>
  </body>
</html>`);
});

// Simple relays UI
app.get("/relays-ui", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const relays = getRelays();
  res.send(`<!DOCTYPE html>
<html>
  <head>
    <title>Relays</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 16px; }
      ul { line-height: 1.6; }
    </style>
  </head>
  <body>
    <h1>Relay URLs</h1>
    <ul>
      ${
        relays.length
          ? relays.map((r) => `<li>${r}</li>`).join("")
          : "<li><em>No relays configured (set RELAY_URLS env)</em></li>"
      }
    </ul>
  </body>
</html>`);
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(
    `[server] Listening on ${PORT} (papertrade=${isPaper()}) — relays UI at http://localhost:${PORT}/relays-ui | status UI at /status-ui | pnl UI at /pnl-ui`
  );

  // Kick off FYERS data socket connection on startup
  connectDataSocket()
    .then(() => {
      console.log("[server] dataSocket connected (FYERS WS initialized)");
    })
    .catch((err) => {
      console.error("[server] Failed to connect FYERS data socket:", err);
    });

  // Log a one-time market clock snapshot for debugging
  try {
    const clock = marketClock();
    console.log(
      `[server] Market clock: now=${new Date().toISOString()} isMarketOpenNow=${clock.isMarketOpenNow()}`
    );
  } catch (e) {
    console.warn("[server] marketClock() failed:", e);
  }
});
