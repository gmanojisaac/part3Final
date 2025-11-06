import express from "express";
import dotenv from "dotenv";
dotenv.config();

import { handleWebhook } from "./webhookHandler";
import { socketManager } from "./dataSocket";

const app = express();

// basic logger
app.use((req, _res, next) => { console.log("Incoming:", req.method, req.path); next(); });

// health
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// accept raw text or JSON
app.post("/webhook", express.text({ type: "*/*", limit: "1mb" }), async (req, res) => {
  try {
    const raw = req.body;
    let payload: any;
    try { payload = typeof raw === "string" ? JSON.parse(raw) : raw; }
    catch { payload = { text: raw }; }

    res.json({ accepted: true });
    await handleWebhook(payload);
  } catch (err) {
    console.error("Webhook error:", err);
    try { res.status(500).json({ error: "processing_failed" }); } catch {}
  }
});

// start the data socket once
socketManager.start();

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Server running on port ${port}`));
