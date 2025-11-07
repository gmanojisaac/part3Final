// server/dataSocket.ts
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// FYERS data socket
const { fyersDataSocket: DataSocket } = require("fyers-api-v3");

function buildAccessTokenString() {
  // SDK expects "APPID:ACCESS_TOKEN"
  const appId = process.env.FYERS_APP_ID || "";
  const token = process.env.FYERS_ACCESS_TOKEN || "";
  return `${appId}:${token}`;
}

class SocketManager {
  private skt: any | null = null;
  private connected = false;
  private subs = new Set<string>();
  private logDir = path.resolve(__dirname, "../fyers_logs");

  start() {
    if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
    const access = buildAccessTokenString();

    this.skt = DataSocket.getInstance(access, this.logDir);

    this.skt.on("connect", () => {
      this.connected = true;
      console.log("✅ DataSocket connected");
      // Re-subscribe whatever we have in memory
      const arr = Array.from(this.subs);
      if (arr.length) {
        try {
          this.skt.subscribe(arr);
          console.log("Subscribed (flush):", arr);
        } catch (e) {
          console.warn("subscribe on connect failed:", e);
        }
      }
    });

    this.skt.on("message", (_msg: any) => {
      // You already wire ticks elsewhere to machines.onTick(...)
      // Keep this if you want to debug raw ticks
      // console.log({ tick: _msg });
    });

    this.skt.on("error", (err: any) => {
      console.warn("DataSocket error:", err);
    });

    this.skt.on("close", () => {
      this.connected = false;
      console.log("DataSocket closed");
    });

    try {
      this.skt.connect();
      this.skt.autoreconnect();
    } catch (e) {
      console.warn("DataSocket start connect failed:", e);
    }
  }

  /** Subscribe adds and pushes to socket if connected */
  subscribe(symbols: string[]) {
    const list = symbols.filter(Boolean);
    let toSend: string[] = [];
    for (const s of list) {
      if (!this.subs.has(s)) {
        this.subs.add(s);
        toSend.push(s);
      }
    }
    if (this.connected && toSend.length) {
      try {
        this.skt.subscribe(toSend);
        console.log("Subscribed:", toSend);
      } catch (e) {
        console.warn("subscribe failed:", e);
      }
    }
  }

  /** Unsubscribe all currently tracked symbols (and clear memory) */
  unsubscribeAll() {
    const arr = Array.from(this.subs);
    if (this.connected && arr.length) {
      try {
        this.skt.unsubscribe(arr);
        console.log("Unsubscribed all:", arr);
      } catch (e) {
        console.warn("unsubscribeAll failed:", e);
      }
    }
    this.subs.clear();
  }

  /** Flush to a given set (replace any old subs) */
  flush(newList: string[] = []) {
    this.unsubscribeAll();
    // Replace with new list and subscribe
    for (const s of newList) this.subs.add(s);
    if (this.connected && newList.length) {
      try {
        this.skt.subscribe(newList);
        console.log("Subscribed (flush):", newList);
      } catch (e) {
        console.warn("flush subscribe failed:", e);
      }
    }
  }

  currentList(): string[] {
    return Array.from(this.subs);
  }
}

export const socketManager = new SocketManager();
