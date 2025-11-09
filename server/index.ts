// server/index.ts
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { isPaper, getPnL } from "./fyersClient";
import { dataSocket } from "./dataSocket";
import { handleWebhookText } from "./webhookHandler";
import { getRelays, addRelay, removeRelay } from "./relayStore";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

/** Relay the incoming message to all configured peers (same content-type + body). */
async function relayToPeers(originalContentType: string | undefined, rawBody: string) {
  const peers = getRelays();
  if (peers.length === 0) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  await Promise.allSettled(
    peers.map(async (url) => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": originalContentType || "text/plain" },
          body: rawBody,
          signal: controller.signal,
        });
        const ok = res.ok ? "OK" : `HTTP ${res.status}`;
        console.log(`[relay] -> ${url} : ${ok}`);
      } catch (e: any) {
        console.warn(`[relay] -> ${url} : ERROR ${e?.message || e}`);
      }
    })
  );

  clearTimeout(timeout);
}

async function main() {
  const app = express();

  // parsers
  app.use(cors());
  app.use(bodyParser.json());
  app.use(bodyParser.text({ type: ["text/*", "application/x-www-form-urlencoded"] }));

  // boot data feed
  await dataSocket.connect();

  /**
   * Webhook for signals.
   * Accepts raw text like: "BUY NIFTY251111C25000"
   * or a JSON body with { text: "..." } — we normalize to string.
   * After handling locally, we relay the SAME message body + content-type to peer URLs.
   */
  app.post("/webhook", async (req, res) => {
    try {
      const contentType = req.headers["content-type"];
      const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}, null, 0);

      // Normalize for local strategy
      const payload =
        typeof req.body === "string"
          ? req.body
          : (req.body && (req.body.text || req.body.message || req.body.payload)) || rawBody;

      const out = await handleWebhookText(payload);

      // fire-and-forget relay
      relayToPeers(typeof contentType === "string" ? contentType : undefined, rawBody).catch(() => {});

      res.json({ ok: true, relayedTo: getRelays().length, ...out });
    } catch (e: any) {
      console.error("[/webhook] error:", e);
      res.status(400).json({ ok: false, error: e?.message || "Webhook error" });
    }
  });

  /**
   * Status (JSON): papertrade flag + pnl snapshot + relays
   */
  app.get("/status", (_req, res) => {
    res.json({
      papertrade: isPaper(),
      pnl: getPnL(),
      relays: getRelays(),
    });
  });

  /** P&L only (JSON) */
  app.get("/pnl", (_req, res) => {
    res.json({
      papertrade: isPaper(),
      pnl: getPnL(),
    });
  });

  /* ------------------------------ Relay Web UI ----------------------------- */

  // Minimal HTML UI to manage relay endpoints
  app.get("/relays", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Relay Peers</title>
<style>
  :root{--fg:#111;--sub:#666;--bg:#fff;--muted:#f6f6f7;--line:#e8e8ea;--ok:#0a7f2e;--danger:#b00020;}
  body { font-family: system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial,sans-serif; margin: 24px; color:var(--fg); background:var(--bg);}
  header { display:flex; gap:16px; align-items:center; margin-bottom:16px; }
  a.nav { text-decoration:none; color:#0366d6; font-weight:600; }
  h1 { font-size: 20px; margin: 0 0 8px 0; }
  .row { display:flex; gap:8px; margin-bottom:12px; }
  input[type="url"]{ flex:1; padding:10px 12px; font-size:14px; border:1px solid var(--line); border-radius:8px; }
  button { padding:10px 14px; font-size:14px; cursor:pointer; border:1px solid var(--line); background:#fafafa; border-radius:8px; }
  table { border-collapse: collapse; width: 100%; margin-top: 12px; }
  td, th { border: 1px solid var(--line); padding: 10px; font-size: 14px; }
  th { background: var(--muted); text-align: left; }
  .muted { color: var(--sub); font-size: 12px; }
</style>
</head>
<body>
  <header>
    <h1>Relay Peers</h1>
    <a class="nav" href="/status-ui">Status</a>
    <a class="nav" href="/pnl-ui">P&L</a>
  </header>
  <div class="row">
    <input id="url" type="url" placeholder="https://1234-xx-xx-xx-xx.ngrok-free.app/webhook" />
    <button id="add">Add</button>
    <button id="test">Send Test</button>
  </div>
  <div class="muted">Every time <code>/webhook</code> receives a message, the same body + content-type is POSTed to all peers.</div>
  <table>
    <thead><tr><th>URL</th><th style="width:140px">Actions</th></tr></thead>
    <tbody id="tbody"></tbody>
  </table>

<script>
async function load() {
  const r = await fetch('/api/relays');
  const { relays=[] } = await r.json();
  const tb = document.getElementById('tbody');
  tb.innerHTML = '';
  relays.forEach(url => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>'+url+'</td><td><button class="remove">Remove</button></td>';
    tr.querySelector('.remove').onclick = async () => {
      await fetch('/api/relays', { method:'DELETE', headers:{'content-type':'application/json'}, body: JSON.stringify({ url })});
      load();
    };
    tb.appendChild(tr);
  });
}

document.getElementById('add').onclick = async () => {
  const url = document.getElementById('url').value.trim();
  if (!url) return;
  const r = await fetch('/api/relays', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ url })});
  const j = await r.json();
  if (!j.ok) alert(j.error || 'Failed');
  document.getElementById('url').value = '';
  load();
};

document.getElementById('test').onclick = async () => {
  const url = document.getElementById('url').value.trim();
  const body = prompt('Optional custom payload (default: "TEST RELAY")', 'TEST RELAY');
  const r = await fetch('/api/relays/test', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ url: url || undefined, body })});
  const j = await r.json();
  alert(JSON.stringify(j, null, 2));
};

load();
</script>
</body>
</html>`);
  });

  // API: list relays
  app.get("/api/relays", (_req, res) => {
    res.json({ relays: getRelays() });
  });

  // API: add relay
  app.post("/api/relays", (req, res) => {
    const url = (req.body?.url || "").toString();
    const r = addRelay(url);
    if (!r.ok) return res.status(400).json(r);
    res.json({ ok: true, relays: getRelays() });
  });

  // API: remove relay
  app.delete("/api/relays", (req, res) => {
    const url = (req.body?.url || "").toString();
    removeRelay(url);
    res.json({ ok: true, relays: getRelays() });
  });

  // API: send test message (to one URL if provided, else to all)
  app.post("/api/relays/test", async (req, res) => {
    const url = req.body?.url ? String(req.body.url) : undefined;
    const body = req.body?.body ?? "TEST RELAY";
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    const urls = url ? [url] : getRelays();

    if (urls.length === 0) return res.status(400).json({ ok: false, error: "No relay URLs configured" });

    const results: Record<string, string> = {};
    await Promise.allSettled(
      urls.map(async (u) => {
        try {
          const r = await fetch(u, { method: "POST", headers: { "content-type": "text/plain" }, body: bodyStr });
          results[u] = r.ok ? `OK (${r.status})` : `HTTP ${r.status}`;
        } catch (e: any) {
          results[u] = `ERROR ${e?.message || e}`;
        }
      })
    );
    res.json({ ok: true, results });
  });

  /* ------------------------------ Status Web UI ---------------------------- */

  // Pretty dashboard for /status JSON (auto-refresh)
  app.get("/status-ui", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Status • Papertrade & Relays</title>
<style>
  :root{--fg:#111;--sub:#666;--bg:#fff;--muted:#f6f6f7;--line:#e8e8ea;--chip:#eef6ff;}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial,sans-serif;margin:24px;color:var(--fg);background:var(--bg);}
  header{display:flex;gap:16px;align-items:center;margin-bottom:16px;}
  a.nav{ text-decoration:none; color:#0366d6; font-weight:600;}
  h1{font-size:20px;margin:0 0 8px 0;}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;}
  .card{border:1px solid var(--line);border-radius:12px;padding:16px;background:#fff;}
  .label{font-size:12px;color:var(--sub);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;}
  .value{font-size:24px;font-weight:700;}
  .chip{display:inline-block;background:var(--chip);border:1px solid #d7e9ff;border-radius:999px;padding:6px 10px;font-size:12px;margin:4px 6px 0 0;}
  table{border-collapse:collapse;width:100%;}
  th,td{border:1px solid var(--line);padding:8px 10px;font-size:14px;}
  th{background:var(--muted);text-align:left;}
  .muted{color:var(--sub);font-size:12px;}
  .pos-green{color:#0a7f2e;font-weight:600;}
  .pos-red{color:#b00020;font-weight:600;}
</style>
</head>
<body>
  <header>
    <h1>Status</h1>
    <a class="nav" href="/relays">Relays</a>
    <a class="nav" href="/pnl-ui">P&L</a>
  </header>

  <div class="grid">
    <div class="card">
      <div class="label">Mode</div>
      <div id="mode" class="value">—</div>
      <div class="muted">Set PAPERTRADE=true to run the in-memory simulator.</div>
    </div>
    <div class="card">
      <div class="label">Total P&L</div>
      <div id="total" class="value">—</div>
      <div class="muted">Realized + Unrealized</div>
    </div>
    <div class="card">
      <div class="label">Peers</div>
      <div id="peers" class="value">—</div>
      <div class="muted">Configured relay targets</div>
    </div>
  </div>

  <div class="card" style="margin-top:16px;">
    <div class="label">By Symbol P&L</div>
    <div class="muted">Live snapshot from <code>/status</code></div>
    <table style="margin-top:8px">
      <thead><tr><th>Symbol</th><th>Pos Qty</th><th>Avg Price</th><th>Last</th><th>Realized</th><th>Unrealized</th></tr></thead>
      <tbody id="bySymbol"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody>
    </table>
  </div>

<script>
async function refresh() {
  try{
    const r = await fetch('/status');
    const j = await r.json();
    document.getElementById('mode').textContent = j.papertrade ? 'Papertrade' : 'Live';
    const total = (j.pnl?.total ?? 0).toFixed(2);
    const realized = (j.pnl?.realized ?? 0).toFixed(2);
    const unrealized = (j.pnl?.unrealized ?? 0).toFixed(2);
    document.getElementById('total').textContent = total + ' (R:'+realized+', U:'+unrealized+')';
    document.getElementById('peers').textContent = (j.relays || []).length;

    const tbody = document.getElementById('bySymbol');
    const entries = Object.entries(j.pnl?.bySymbol || {});
    if(entries.length === 0){
      tbody.innerHTML = '<tr><td colspan="6" class="muted">No data</td></tr>';
    } else {
      tbody.innerHTML = '';
      for (const [sym, v] of entries) {
        const u = Number(v.unrealized||0);
        const cls = u >= 0 ? 'pos-green' : 'pos-red';
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>'+sym+'</td>'
          + '<td>'+ (v.posQty ?? 0) +'</td>'
          + '<td>'+ (v.avgPrice ?? 0).toFixed(2) +'</td>'
          + '<td>'+ (v.last ?? 0).toFixed(2) +'</td>'
          + '<td>'+ (v.realized ?? 0).toFixed(2) +'</td>'
          + '<td class="'+cls+'">'+ u.toFixed(2) +'</td>';
        tbody.appendChild(tr);
      }
    }
  }catch(e){ console.error(e); }
}

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`);
  });

  /* ------------------------------ P&L Web UI ------------------------------- */

  // Compact live P&L page fed from /pnl (auto-refresh)
  app.get("/pnl-ui", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>P&L</title>
<style>
  :root{--fg:#111;--sub:#666;--bg:#fff;--muted:#f6f6f7;--line:#e8e8ea;}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial,sans-serif;margin:24px;color:var(--fg);background:var(--bg);}
  header{display:flex;gap:16px;align-items:center;margin-bottom:16px;}
  a.nav{ text-decoration:none; color:#0366d6; font-weight:600;}
  h1{font-size:20px;margin:0 0 8px 0;}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;}
  .card{border:1px solid var(--line);border-radius:12px;padding:16px;background:#fff;}
  .label{font-size:12px;color:var(--sub);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;}
  .value{font-size:24px;font-weight:700;}
  table{border-collapse:collapse;width:100%;margin-top:8px;}
  th,td{border:1px solid var(--line);padding:8px 10px;font-size:14px;}
  th{background:var(--muted);text-align:left;}
  .pos-green{color:#0a7f2e;font-weight:600;}
  .pos-red{color:#b00020;font-weight:600;}
</style>
</head>
<body>
  <header>
    <h1>P&L</h1>
    <a class="nav" href="/relays">Relays</a>
    <a class="nav" href="/status-ui">Status</a>
  </header>

  <div class="grid">
    <div class="card">
      <div class="label">Mode</div>
      <div id="mode" class="value">—</div>
    </div>
    <div class="card">
      <div class="label">Total</div>
      <div id="total" class="value">—</div>
    </div>
    <div class="card">
      <div class="label">Realized</div>
      <div id="realized" class="value">—</div>
    </div>
    <div class="card">
      <div class="label">Unrealized</div>
      <div id="unrealized" class="value">—</div>
    </div>
  </div>

  <div class="card" style="margin-top:16px;">
    <div class="label">By Symbol</div>
    <table>
      <thead><tr><th>Symbol</th><th>Pos Qty</th><th>Avg Price</th><th>Last</th><th>Realized</th><th>Unrealized</th></tr></thead>
      <tbody id="bySymbol"><tr><td colspan="6">Loading…</td></tr></tbody>
    </table>
  </div>

<script>
async function refresh() {
  try{
    const r = await fetch('/pnl');
    const j = await r.json();
    document.getElementById('mode').textContent = j.papertrade ? 'Papertrade' : 'Live';
    document.getElementById('total').textContent = (j.pnl?.total ?? 0).toFixed(2);
    document.getElementById('realized').textContent = (j.pnl?.realized ?? 0).toFixed(2);
    document.getElementById('unrealized').textContent = (j.pnl?.unrealized ?? 0).toFixed(2);

    const tbody = document.getElementById('bySymbol');
    const entries = Object.entries(j.pnl?.bySymbol || {});
    if(entries.length === 0){
      tbody.innerHTML = '<tr><td colspan="6" class="muted">No positions</td></tr>';
    } else {
      tbody.innerHTML = '';
      for (const [sym, v] of entries) {
        const u = Number(v.unrealized||0);
        const cls = u >= 0 ? 'pos-green' : 'pos-red';
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>'+sym+'</td>'
          + '<td>'+ (v.posQty ?? 0) +'</td>'
          + '<td>'+ (v.avgPrice ?? 0).toFixed(2) +'</td>'
          + '<td>'+ (v.last ?? 0).toFixed(2) +'</td>'
          + '<td>'+ (v.realized ?? 0).toFixed(2) +'</td>'
          + '<td class="'+cls+'">'+ u.toFixed(2) +'</td>';
        tbody.appendChild(tr);
      }
    }
  }catch(e){ console.error(e); }
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`);
  });

  app.listen(PORT, () => {
    console.log(`[server] Listening on ${PORT} (papertrade=${isPaper()}) — relay UI at http://localhost:${PORT}/relays  |  status UI at /status-ui  |  pnl UI at /pnl-ui`);
  });
}

main().catch((e) => {
  console.error("Fatal boot error:", e);
  process.exit(1);
});
