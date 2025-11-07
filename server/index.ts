// server/index.ts
import express from "express";
import dotenv from "dotenv";
dotenv.config();

import { handleWebhook } from "./webhookHandler";
import { socketManager } from "./dataSocket";
import { resumeAllMachines } from "./resumer";
import { wipeStore, STORE } from "./stateStore";

const app = express();

// basic logger
app.use((req, _res, next) => {
  console.log("Incoming:", req.method, req.path);
  next();
});

// health
app.get("/healthz", (_req, res) => res.json({ ok: true, store: STORE }));

// accept raw text or JSON
app.post(
  "/webhook",
  express.text({ type: "*/*", limit: "1mb" }),
  async (req, res) => {
    try {
      const raw = req.body;
      let payload: any;
      try {
        payload = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        payload = { text: raw };
      }

      res.json({ accepted: true });
      await handleWebhook(payload);
    } catch (err) {
      console.error("Webhook error:", err);
      try {
        res.status(500).json({ error: "processing_failed" });
      } catch {}
    }
  }
);

// 1) If FRESH_START=1, nuke store & unsubscribe everything BEFORE socket start
const fresh = (process.env.FRESH_START || "").trim() === "1";
if (fresh) {
  console.log("[BOOT] FRESH_START=1 → wiping persistence and socket subs");
  wipeStore();
  // socket not started yet; ensure it starts empty
}

// 2) Start the data socket (it will re-subscribe whatever is in memory)
socketManager.start();

// If fresh, explicitly flush to zero symbols on connect
if (fresh) {
  // We call flush with empty list – on connect it prints Subscribed (flush): []
  socketManager.flush([]);
}

// 3) Resume machines from disk unless fresh start
resumeAllMachines()
  .then(() => console.log("Resume done."))
  .catch((e) => console.warn("Resume failed:", e));

// 4) Start server
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Server running on port ${port}`));
