// server/index.ts
// ---------------------------------------------------------------------------
// Load environment variables before anything else
// ---------------------------------------------------------------------------
import "dotenv/config";

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import express from "express";
import bodyParser from "body-parser";

import { handleWebhookText, webhookStatus } from "./webhookHandler";
import { dataSocket } from "./dataSocket"; // ensures sockets get initialized
import { getPnL, isPaper, getTrades } from "./fyersClient";
import { marketClock } from "./marketHours";
import { getRelays, relayToAll } from "./relayStore";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT ?? 3000);
const app = express();

// For webhook: use raw text
app.use("/webhook", bodyParser.text({ type: "*/*" }));

// For all other routes: JSON
app.use(bodyParser.json());

// ---------------------------------------------------------------------------
// Webhook endpoint
// ---------------------------------------------------------------------------
app.post("/webhook", async (req, res) => {
  const raw =
    typeof req.body === "string" ? req.body : JSON.stringify(req.body);

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

// Engine / webhook status
app.get("/status", (_req, res) => {
  res.json(webhookStatus());
});

// PnL JSON
app.get("/pnl", (_req, res) => {
  res.json(getPnL());
});

// Trades JSON
app.get("/trades", (_req, res) => {
  res.json({ trades: getTrades() });
});

// Relays JSON
app.get("/relays", (_req, res) => {
  res.json({ relays: getRelays() });
});

// Optional: relay test broadcast
app.post("/relay-test", async (req, res) => {
  const payload =
    typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  try {
    const result = await relayToAll(payload);
    res.json({ ok: true, result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message ?? String(err) });
  }
});

// Market clock JSON
app.get("/market-clock", (_req, res) => {
  res.json(marketClock());
});

// ---------------------------------------------------------------------------
// Simple HTML UIs
// ---------------------------------------------------------------------------

// Status UI
app.get("/status-ui", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Webhook / Engine Status</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 16px; }
    pre { background:#111; color:#0f0; padding:12px; border-radius:6px; }
    .ok { color: #0a0; }
    .bad { color: #c00; }
  </style>
</head>
<body>
  <h1>Webhook / Engine Status</h1>
  <div id="status"></div>
  <pre id="raw"></pre>

  <script>
    async function refresh() {
      try {
        const res = await fetch('/status');
        const data = await res.json();
        const el = document.getElementById('status');

        const parts = [];
        if (typeof data.paper !== 'undefined') {
          parts.push('Mode: ' + (data.paper ? 'PAPER' : 'LIVE'));
        }
        if (typeof data.nowOpen !== 'undefined') {
          parts.push('Market now: ' + (data.nowOpen ? 'OPEN' : 'CLOSED'));
        }

        el.innerHTML = '<p>' + parts.join('<br>') + '</p>';

        document.getElementById('raw').textContent = JSON.stringify(data, null, 2);
      } catch (e) {
        document.getElementById('status').innerHTML =
          '<p class="bad">Error loading status: ' + e + '</p>';
      }
    }
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`);
});

// PnL UI
app.get("/pnl-ui", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>P&amp;L</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 16px; }
    h1 { margin-bottom: 0.5rem; }
    .summary { margin-bottom: 1rem; }
    .summary span { display:inline-block; min-width: 160px; }
    table { border-collapse: collapse; width: 100%; margin-top: 8px; }
    th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: right; }
    th { background: #f0f0f0; }
    td.sym, th.sym { text-align: left; }
    .pos-pos { color: #0a0; }
    .pos-neg { color: #c00; }
    pre { background:#111; color:#0f0; padding:12px; border-radius:6px; margin-top:16px; }
  </style>
</head>
<body>
  <h1>P&amp;L</h1>
  <div class="summary" id="summary"></div>
  <table id="pnl-table">
    <thead>
      <tr>
        <th class="sym">Symbol</th>
        <th>Pos Qty</th>
        <th>Avg Price</th>
        <th>Last</th>
        <th>Realized</th>
        <th>Unrealized</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>

  <pre id="raw"></pre>

  <script>
    function fmt(x) {
      if (typeof x !== 'number') return x;
      return x.toFixed(2);
    }

    function clsPnL(v) {
      if (v > 0) return 'pos-pos';
      if (v < 0) return 'pos-neg';
      return '';
    }

    async function refresh() {
      try {
        const res = await fetch('/pnl');
        const data = await res.json();

        const sum = document.getElementById('summary');
        sum.innerHTML =
          '<span>Total: ' + fmt(data.total) + '</span>' +
          '<span>Realized: ' + fmt(data.realized) + '</span>' +
          '<span>Unrealized: ' + fmt(data.unrealized) + '</span>';

        const tbody = document.querySelector('#pnl-table tbody');
        tbody.innerHTML = '';

        const bySymbol = data.bySymbol || {};
        Object.keys(bySymbol).sort().forEach(sym => {
          const row = bySymbol[sym];
          const tr = document.createElement('tr');

          tr.innerHTML =
            '<td class="sym">' + sym + '</td>' +
            '<td>' + row.posQty + '</td>' +
            '<td>' + fmt(row.avgPrice) + '</td>' +
            '<td>' + fmt(row.last) + '</td>' +
            '<td class="' + clsPnL(row.realized) + '">' + fmt(row.realized) + '</td>' +
            '<td class="' + clsPnL(row.unrealized) + '">' + fmt(row.unrealized) + '</td>';

          tbody.appendChild(tr);
        });

        document.getElementById('raw').textContent = JSON.stringify(data, null, 2);
      } catch (e) {
        document.getElementById('summary').innerHTML =
          '<span style="color:#c00">Error loading P&amp;L: ' + e + '</span>';
      }
    }

    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`);
});

// Trades UI
app.get("/trades-ui", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Executed Trades</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 16px; }
    h1 { margin-bottom: 1rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: right; }
    th { background: #f0f0f0; }
    td.sym, th.sym { text-align: left; }
    td.buy { color: #0a0; font-weight: bold; }
    td.sell { color: #c00; font-weight: bold; }
    td.pnl-pos { color: #0a0; }
    td.pnl-neg { color: #c00; }
    pre { background:#111; color:#0f0; padding:12px; border-radius:6px; margin-top:16px; }
  </style>
</head>

<body>
  <h1>Trades Executed</h1>

  <table id="trade-table">
    <thead>
      <tr>
        <th>Time</th>
        <th class="sym">Symbol</th>
        <th>Side</th>
        <th>Qty</th>
        <th>Price</th>
        <th>P&amp;L</th>
        <th>P&amp;L Total</th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>

  <pre id="raw"></pre>

  <script>
    function fmt(x) {
      if (typeof x !== 'number') return x;
      return x.toFixed(2);
    }

    function clsPnL(v) {
      if (v > 0) return 'pnl-pos';
      if (v < 0) return 'pnl-neg';
      return '';
    }

    async function refresh() {
      try {
        const res = await fetch('/trades');
        const data = await res.json();
        const trades = data.trades || [];

        const tbody = document.querySelector('#trade-table tbody');
        tbody.innerHTML = '';

        let running = 0;

        trades.forEach(t => {
          running += (t.realized || 0);

          const tr = document.createElement('tr');

          tr.innerHTML =
            '<td>' + (t.ts ? new Date(t.ts).toLocaleTimeString() : '') + '</td>' +
            '<td class="sym">' + t.sym + '</td>' +
            '<td class="' + (t.side === 'BUY' ? 'buy' : 'sell') + '">' + t.side + '</td>' +
            '<td>' + t.qty + '</td>' +
            '<td>' + fmt(t.price) + '</td>' +
            '<td class="' + clsPnL(t.realized) + '">' + fmt(t.realized) + '</td>' +
            '<td class="' + clsPnL(running) + '">' + fmt(running) + '</td>';

          tbody.appendChild(tr);
        });

        document.getElementById('raw').textContent = JSON.stringify(data, null, 2);
      } catch (e) {
        document.getElementById('raw').textContent = 'Error loading trades: ' + e;
      }
    }

    refresh();
    setInterval(refresh, 5000);
  </script>

</body>
</html>`);
});

// Relays UI
app.get("/relays-ui", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Relays</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 16px; }
    li { margin: 4px 0; }
    code { background:#f4f4f4; padding:2px 4px; border-radius:3px; }
    pre { background:#111; color:#0f0; padding:12px; border-radius:6px; margin-top:16px; }
  </style>
</head>
<body>
  <h1>Configured Relays</h1>
  <p>These come from <code>RELAY_URLS</code> env (and any additions at runtime).</p>
  <ul id="relay-list"></ul>
  <pre id="raw"></pre>

  <script>
    async function refresh() {
      try {
        const res = await fetch('/relays');
        const data = await res.json();
        const list = document.getElementById('relay-list');
        list.innerHTML = '';
        (data.relays || []).forEach(url => {
          const li = document.createElement('li');
          li.textContent = url;
          list.appendChild(li);
        });
        document.getElementById('raw').textContent = JSON.stringify(data, null, 2);
      } catch (e) {
        document.getElementById('relay-list').innerHTML =
          '<li style="color:#c00">Error loading relays: ' + e + '</li>';
      }
    }
    refresh();
    setInterval(refresh, 10000);
  </script>
</body>
</html>`);
});

// Market clock UI
app.get("/market-ui", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Market Clock</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 16px; }
    pre { background:#111; color:#0f0; padding:12px; border-radius:6px; }
  </style>
</head>
<body>
  <h1>Market Clock</h1>
  <div id="info"></div>
  <pre id="raw"></pre>

  <script>
    async function refresh() {
      try {
        const res = await fetch('/market-clock');
        const data = await res.json();
        const info = document.getElementById('info');
        info.innerHTML =
          '<p>Now: ' + (data.nowLocal || '') + '</p>' +
          '<p>Is Market Open Now: ' + (data.isMarketOpenNow ? 'YES' : 'NO') + '</p>' +
          '<p>Session: ' + (data.sessionLabel || '') + '</p>';
        document.getElementById('raw').textContent = JSON.stringify(data, null, 2);
      } catch (e) {
        document.getElementById('info').innerHTML =
          '<p style="color:#c00">Error loading market clock: ' + e + '</p>';
      }
    }
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`);
});

// Root index page
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Relay / Engine Control</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 16px; }
    ul { line-height: 1.8; }
  </style>
</head>
<body>
  <h1>Relay / Engine Control</h1>
  <p>Mode: <strong>${isPaper() ? "PAPER" : "LIVE"}</strong></p>
  <ul>
    <li><a href="/status-ui">Status UI</a></li>
    <li><a href="/pnl-ui">PnL UI</a></li>
    <li><a href="/relays-ui">Relays UI</a></li>
    <li><a href="/market-ui">Market Clock</a></li>
    <li><a href="/trades-ui">Trades Executed</a></li>
  </ul>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(
    `[server] Listening on ${PORT} (papertrade=${isPaper()}) — relay UI at http://localhost:${PORT}/relays-ui  |  status UI at /status-ui  |  pnl UI at /pnl-ui  |  trades UI at /trades-ui`
  );

  // Touch dataSocket so it initializes (if it has side-effects on import)
  if (dataSocket) {
    console.log("[server] dataSocket imported, sockets should be connecting…");
  }
});
