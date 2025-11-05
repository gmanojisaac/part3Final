import dotenv from "dotenv";
import fs from "fs";
import path from "path";
dotenv.config();

// Use CommonJS-style require for best compatibility with the SDK
const { fyersOrderSocket: FyersOrderSocket } = require("fyers-api-v3");

// 1) Token must be "APPID:ACCESS_TOKEN"
const APP_ID = process.env.FYERS_APP_ID || "R3PYOUE8EO-100";
const ACCESS_TOKEN = process.env.FYERS_ACCESS_TOKEN || ""; // from your auth flow
const FULL_TOKEN = `${APP_ID}:${ACCESS_TOKEN}`;

// 2) Ensure log directory exists (SDK writes rotating logs here)
const logDir = path.resolve(__dirname, "fyers_logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

// 3) Create the socket
const skt = new FyersOrderSocket(FULL_TOKEN, logDir);

// 4) Wire up events
skt.on("error", (errmsg: any) => {
  console.error("❌ order-socket error:", errmsg);
});

skt.on("general", (msg: any) => {
  // General info (auth acks, system notes, etc.)
  console.log("ℹ️ general:", msg);
});

skt.on("connect", () => {
  console.log("✅ order-socket connected");
  // Subscribe to the channels you need (built-in constants on the socket instance)
  // Common channels: skt.orders, skt.trades, skt.positions, skt.edis, skt.pricealerts
  skt.subscribe([skt.orders, skt.trades, skt.positions, skt.edis, skt.pricealerts]);
  console.log("isConnected:", skt.isConnected());
});

skt.on("close", () => {
  console.log("🔌 order-socket closed");
});

skt.on("orders", (msg: any) => {
  console.log("🧾 orders:", JSON.stringify(msg));
  // TODO: route to your OMS -> update order state, attach SL after FILLED, etc.
});

skt.on("trades", (msg: any) => {
  console.log("✅ trades:", JSON.stringify(msg));
  // TODO: mark fills, compute avg price, PnL updates
});

skt.on("positions", (msg: any) => {
  console.log("📊 positions:", JSON.stringify(msg));
  // TODO: sync internal position map with broker view
});

// 5) Start & autoreconnect
skt.autoreconnect();
skt.connect();

// Optional: graceful shutdown
process.on("SIGINT", () => {
  console.log("👋 shutting down order socket…");
  try { skt.closeConnection?.(); } catch {}
  process.exit(0);
});
