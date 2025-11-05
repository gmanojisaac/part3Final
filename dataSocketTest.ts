import dotenv from "dotenv";
import fs from "fs";
import path from "path";

// Load your .env (with FYERS_APP_ID and FYERS_ACCESS_TOKEN)
dotenv.config();

// Import the DataSocket class from the SDK
const { fyersDataSocket: DataSocket } = require("fyers-api-v3");

// --------------------------------------------------------------------
// 1️⃣ Prepare the access token in correct format
// --------------------------------------------------------------------
// Format: "APPID:ACCESS_TOKEN"
// Example: "R3PYOUE8EO-100:eyJ0eXAiOiJKV1QiLCJhb..."
const APP_ID = process.env.FYERS_APP_ID || "R3PYOUE8EO-100";
const ACCESS_TOKEN = process.env.FYERS_ACCESS_TOKEN;
const FULL_TOKEN = `${APP_ID}:${ACCESS_TOKEN}`;

// --------------------------------------------------------------------
// 2️⃣ Ensure a log directory exists
// --------------------------------------------------------------------
const logPath = path.resolve(__dirname, "fyers_logs");
if (!fs.existsSync(logPath)) {
  fs.mkdirSync(logPath, { recursive: true });
}

// --------------------------------------------------------------------
// 3️⃣ Create DataSocket instance
// --------------------------------------------------------------------
const skt = DataSocket.getInstance(FULL_TOKEN, logPath);

// --------------------------------------------------------------------
// 4️⃣ Setup event listeners
// --------------------------------------------------------------------

// Fired once the socket connects successfully
skt.on("connect", function () {
  console.log("✅ Socket connected to FYERS data stream");

  // Subscribe to some NSE symbols (equity or index)
  // You can add Options, Futures, etc.
  skt.subscribe(["NSE:NIFTY25N1125000CE"]); //"NSE:SBIN-EQ", "NSE:RELIANCE-EQ", "NSE:NIFTY50-INDEX"
  skt.mode(skt.LiteMode)
  // Check connection status
  console.log("isConnected:", skt.isConnected());
});

// Fired whenever a tick (price update) comes
skt.on("message", function (message: any) {
  console.log("📈 Tick:", message);
});

// Fired on error events
skt.on("error", function (err: any) {
  console.error("❌ Socket error:", err);
});

// Fired when connection closes
skt.on("close", function () {
  console.log("🔌 Socket closed");
});

// --------------------------------------------------------------------
// 5️⃣ Connect and enable auto-reconnect
// --------------------------------------------------------------------
skt.connect();
skt.autoreconnect();
