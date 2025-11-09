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

  // Use native fetch (Node >=18)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  await Promise.allSettled(
    peers.map(async (url) => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": originalContentType || "text/plain",
          },
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
      const rawBody =
        typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}, null, 0);

      // Normalize for local strategy
      const payload =
        typeof req.body === "string"
          ? req.body
          : (req.body && (req.body.text || req.body.message || req.body.payload)) ||
            rawBody;

      const out = await handleWebhookText(payload);

      // Fire-and-forget relay (don’t await to keep the webhook fast). If you prefer, await it.
      relayToPeers(typeof contentType === "string" ? contentType : undefined, rawBody).catch(() => {});

      res.json({ ok: true, relayedTo: getRelays().length, ...out });
    } catch (e: any) {
      console.error("[/webhook] error:", e);
      res.status(400).json({ ok: false, error: e?.message || "Webhook error" });
    }
  });

  /**
   * Status: show papertrade flag + pnl snapshot.
   */
  app.get("/status", (_req, res) => {
    res.json({
      papertrade: isPaper(),
      pnl: getPnL(),
      relays: getRelays(),
    });
  });

  /** Focused P&L endpoint */
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
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 24px; }
  h1 { font-size: 20px; margin-bottom: 12px; }
  .row { display:flex; gap:8px; margin-bottom:12px; }
  input[type="url"]{ flex:1; padding:8px; font-size:14px; }
  button { padding:8px 12px; font-size:14px; cursor:pointer; }
  table { border-collapse: collapse; width: 100%; margin-top: 12px; }
  td, th { border: 1px solid #ddd; padding: 8px; font-size: 14px; }
  th { background: #f5f5f5; text-align: left; }
  .muted { color: #666; font-size: 12px; }
</style>
</head>
<body>
  <h1>Relay Peers</h1>
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

  app.listen(PORT, () => {
    console.log(`[server] Listening on ${PORT} (papertrade=${isPaper()}) — relay UI at http://localhost:${PORT}/relays`);
  });
}

main().catch((e) => {
  console.error("Fatal boot error:", e);
  process.exit(1);
});
