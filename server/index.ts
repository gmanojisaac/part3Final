// ---------------------------------------------------------------------------
// ✅ Load environment variables FIRST — before importing anything else.
// ---------------------------------------------------------------------------
import "dotenv/config";

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import express from "express";
import bodyParser from "body-parser";
import { handleWebhookText } from "./webhookHandler";
import { dataSocket } from "./dataSocket";
import { getPnL, isPaper } from "./fyersClient";
import { marketClock } from "./marketHours";
import { getRelays, relayToAll } from "./relayStore";
import { webhookStatus } from "./webhookHandler";

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 3000);
const app = express();
app.use(bodyParser.text({ type: "*/*" }));

// ---------------------------------------------------------------------------
// Safe spread helper
// ---------------------------------------------------------------------------
function toSpreadableObject(out: unknown): Record<string, unknown> {
  if (out && typeof out === "object" && !Array.isArray(out)) return out as Record<string, unknown>;
  if (Array.isArray(out)) return { items: out };
  if (out === undefined || out === null) return {};
  return { result: out };
}

// ---------------------------------------------------------------------------
// Startup data socket (Fyers WS) before handling any requests
// ---------------------------------------------------------------------------
(async () => {
  await dataSocket.connect();
})();

// ---------------------------------------------------------------------------
// Webhook route
// ---------------------------------------------------------------------------
app.post("/webhook", async (req, res) => {
  const body = req.body?.toString()?.trim();
  if (!body) return res.status(400).json({ error: "Empty webhook body" });

  try {
    await handleWebhookText(body);
    const out = await relayToAll(body);
    res.json({
      ok: true,
      relayedTo: getRelays().length,
      ...toSpreadableObject(out),
    });
  } catch (err: any) {
    console.error("[/webhook] error:", err);
    res.status(500).json({ ok: false, error: err?.message ?? "Unknown error" });
  }
});

// ---------------------------------------------------------------------------
// Health & debug routes
// ---------------------------------------------------------------------------
app.get("/status-ui", (_req, res) => {
  res.send(`
    <html>
      <head><title>Status UI</title></head>
      <body>
        <h2>Status</h2>
        <pre>${JSON.stringify(webhookStatus(), null, 2)}</pre>
      </body>
    </html>
  `);
});

app.get("/pnl-ui", (_req, res) => {
  res.json({ papertrade: isPaper(), pnl: getPnL() });
});

app.get("/market-ui", (_req, res) => {
  res.json(marketClock());
});

app.get("/", (_req, res) => {
  res.send(
    `<h2>Server running (papertrade=${isPaper()})</h2>
     <ul>
       <li><a href="/status-ui">Status UI</a></li>
       <li><a href="/pnl-ui">PnL UI</a></li>
       <li><a href="/market-ui">Market Clock</a></li>
     </ul>`
  );
});

// ---------------------------------------------------------------------------
// Start Express server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(
    `[server] Listening on ${PORT} (papertrade=${isPaper()}) — relay UI at http://localhost:${PORT}/relays  |  status UI at /status-ui  |  pnl UI at /pnl-ui`
  );
});
