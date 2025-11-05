/*import express from "express";
import dotenv from "dotenv";
import { handleWebhook } from "./webhookHandler";

dotenv.config();
const app = express();
app.use(express.json());

app.get("/healthz", (_, res) => res.json({ ok: true }));

app.post("/webhook", async (req, res) => {
  res.json({ accepted: true });
  handleWebhook(req.body).catch(err => console.error("Webhook error:", err));
});

app.listen(process.env.PORT || 3000, () =>
  console.log(`Server running on port ${process.env.PORT || 3000}`)
);*/
// server/index.ts (only show the changed bits)
import express from "express";
import dotenv from "dotenv";
import { handleWebhook } from "./webhookHandler";
dotenv.config();

const app = express();

// Log incoming method/path for quick troubleshooting
app.use((req, _res, next) => {
  console.log("Incoming:", req.method, req.path);
  next();
});

// Health
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Accept both text/plain and application/json for /webhook
app.post(
  "/webhook",
  // try to parse text first; if not text, fall back to JSON
  express.text({ type: "*/*", limit: "1mb" }),
  async (req, res) => {
    try {
      // If the body looks like JSON, parse it; else it’s raw text
      const raw = req.body;
      let payload: any;
      try {
        payload = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        payload = { text: raw }; // raw text from Postman
      }

      res.json({ accepted: true }); // ack immediately
      await handleWebhook(payload);
    } catch (err) {
      console.error("Webhook error:", err);
      try { res.status(500).json({ error: "processing_failed" }); } catch {}
    }
  }
);

app.listen(process.env.PORT || 3000, () =>
  console.log(`Server running on port ${process.env.PORT || 3000}`)
);

