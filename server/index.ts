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

// ---------------------------------------------------------------------------
// Express app setup
// ---------------------------------------------------------------------------
const app = express();
const PORT = Number(process.env.PORT || 4000);

app.use(bodyParser.text({ type: "*/*" })); // raw text (JSON or plain)

// ---------------------------------------------------------------------------
// Webhook endpoint
// ---------------------------------------------------------------------------

app.post("/webhook", async (req: Request, res: Response) => {
  try {
    const bodyText = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    await handleWebhookText(bodyText);
    res.json({ ok: true });
  } catch (err: any) {
    console.error("[/webhook] ERROR:", err);
    res
      .status(500)
      .json({ ok: false, error: err?.message ?? String(err) });
  }
});
// ---------------------------------------------------------------------------
// JSON APIs
// ---------------------------------------------------------------------------

// Engine / market status
app.get("/status", (_req: Request, res: Response) => {
  res.json(webhookStatus());
});

// P&L + trades snapshot
app.get("/pnl", (_req: Request, res: Response) => {
  const pnl = getPnL();
  const trades = getTrades();
  res.json({
    ...pnl,
    trades,
  });
});

// Trades only – in case you want a separate consumer
app.get("/trades", (_req: Request, res: Response) => {
  res.json(getTrades());
});

// ---------------------------------------------------------------------------
// Status UI
// ---------------------------------------------------------------------------

app.get("/", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html>
  <head>
    <title>Webhook status</title>
    <meta charset="utf-8" />
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 16px; }
      h1 { margin-bottom: 8px; }
      table { border-collapse: collapse; margin-top: 8px; }
      th, td { padding: 4px 8px; border: 1px solid #ccc; font-size: 14px; text-align: left; }
      .ok { color: #2b8a3e; }
      .bad { color: #c92a2a; }
      .muted { color: #666; }
      .pill { display: inline-block; padding: 2px 6px; border-radius: 999px; background: #eee; font-size: 12px; }
    </style>
  </head>
  <body>
    <h1>Status</h1>
    <div id="status"></div>

    <script>
      function cls(ok) {
        if (ok === true) return 'ok';
        if (ok === false) return 'bad';
        return '';
      }

      async function refresh() {
        try {
          const res = await fetch('/status');
          const data = await res.json();

          let html = '<table>';
          html += '<tr><th>Key</th><th>Value</th></tr>';

          html += '<tr><td>Paper / Live</td><td>${isPaper() ? "PAPER" : "LIVE"}</td></tr>';
          html += '<tr><td>Webhook enabled</td><td class="' + cls(data.webhookEnabled) + '">' + data.webhookEnabled + '</td></tr>';
          html += '<tr><td>Last webhook at</td><td>' + (data.lastWebhookAt || '-') + '</td></tr>';
          html += '<tr><td>Last webhook status</td><td>' + (data.lastStatus || '-') + '</td></tr>';
          html += '<tr><td>Last webhook message</td><td class="muted">' + (data.lastMessage || '-') + '</td></tr>';

          html += '</table>';

          document.getElementById('status').innerHTML = html;
        } catch (e) {
          document.getElementById('status').textContent = 'Error: ' + e;
        }
      }

      refresh();
      setInterval(refresh, 5000);
    </script>
  </body>
</html>`);
});

// ---------------------------------------------------------------------------
// PnL UI – with brokerage based on closed trades, status, etc.
// ---------------------------------------------------------------------------

app.get("/pnl-ui", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html>
  <head>
    <title>PnL</title>
    <meta charset="utf-8" />
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 16px; }
      h1 { margin-bottom: 8px; }
      h2 { margin-top: 24px; margin-bottom: 8px; font-size: 16px; }
      table { border-collapse: collapse; margin-top: 8px; width: 100%; max-width: 900px; }
      th, td { padding: 4px 8px; border: 1px solid #ccc; font-size: 12px; text-align: right; }
      th:first-child, td:first-child { text-align: left; }
      .pos { color: #2b8a3e; }
      .neg { color: #c92a2a; }
      .status {
        display: inline-block;
        margin-bottom: 8px;
        padding: 4px 8px;
        border-radius: 999px;
        background: #f1f3f5;
        font-weight: 600;
        font-size: 14px;
      }
      .status-profit { color: #2b8a3e; }
      .status-loss { color: #c92a2a; }
      .status-breakeven { color: #555; }
    </style>
  </head>
  <body>
    <h1>PnL Snapshot</h1>
    <div id="status"></div>
    <div id="summary"></div>
    <h2>Trades</h2>
    <div id="trades"></div>

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

          // --- Basic pieces from API ---
          const realizedNet = data.realized || 0;          // net after brokerage in engine
          const unrealized = data.unrealized || 0;
          const grossRealized = data.grossRealized || 0;   // BEFORE brokerage

          // Gross P&L = gross realized + unrealized
          const grossPnL = grossRealized + unrealized;

          // Brokerage from engine (sum of per-trade brokerage)
          const brokerage = data.brokerage || 0;

          // Net P&L after brokerage
          const netPnL = grossPnL + brokerage;

          // For backwards compatibility, treat "total" as net P&L
          const total = netPnL;

          // --- Status (PROFIT / LOSS / BREAKEVEN) ---
          let statusText = 'BREAKEVEN';
          let statusClass = 'status-breakeven';

          if (netPnL > 0.5) {
            statusText = 'PROFIT';
            statusClass = 'status-profit';
          } else if (netPnL < -0.5) {
            statusText = 'LOSS';
            statusClass = 'status-loss';
          }

          const statusEl = document.getElementById('status');
          statusEl.textContent = 'Status: ' + statusText;
          statusEl.className = 'status ' + statusClass;

          // --- Summary table ---
          let summaryHtml = '<table>';
          summaryHtml += '<thead><tr><th>Metric</th><th>Value</th></tr></thead>';
          summaryHtml += '<tbody>';

          summaryHtml += '<tr><td>Net P&L (after brokerage)</td><td class="' + cls(netPnL) + '">' + fmt2(netPnL) + '</td></tr>';
          summaryHtml += '<tr><td>Gross P&L (before brokerage)</td><td class="' + cls(grossPnL) + '">' + fmt2(grossPnL) + '</td></tr>';
          summaryHtml += '<tr><td>Brokerage (per closed trades)</td><td class="' + cls(brokerage) + '">' + fmt2(brokerage) + '</td></tr>';

          summaryHtml += '<tr><td>Realized P&L (net)</td><td class="' + cls(realizedNet) + '">' + fmt2(realizedNet) + '</td></tr>';
          summaryHtml += '<tr><td>Unrealized P&L</td><td class="' + cls(unrealized) + '">' + fmt2(unrealized) + '</td></tr>';

          summaryHtml += '</tbody></table>';
          document.getElementById('summary').innerHTML = summaryHtml;

          // --- Trades table ---
          const trades = Array.isArray(data.trades)
            ? data.trades.slice().sort((a, b) => b.ts - a.ts)
            : [];

          const rows = [];
          for (const t of trades) {
            const pnl = t.realized || 0;
            rows.push(
              '<tr>' +
                '<td>' + fmtTime(t.ts) + '</td>' +
                '<td>' + t.symbol + '</td>' +
                '<td>' + t.side + '</td>' +
                '<td>' + t.qty + '</td>' +
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
            '<th>Realized P&L</th>' +
          '</tr></thead>';
          tradesHtml += '<tbody>' + rows.join('') + '</tbody></table>';
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

// ---------------------------------------------------------------------------
// Local numeric relay UI (if you had that below) – unchanged from your file
// ---------------------------------------------------------------------------

/* whatever relay UI / other routes you had below remain the same;
   I did not touch anything except the /pnl-ui script block and comments. */

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

connectDataSocket();

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
