import dotenv from "dotenv";
dotenv.config();

const { fyersDataSocket: DataSocket } = require("fyers-api-v3");

class SocketManager {
  private skt: any | null = null;
  private started = false;
  private pendingSubs = new Set<string>();

  start() {
    if (this.started) return;
    this.started = true;

    const fullToken = `${process.env.FYERS_APP_ID}:${process.env.FYERS_ACCESS_TOKEN}`;
    this.skt = DataSocket.getInstance(fullToken, "./fyers_logs");

    this.skt.on("connect", () => {
      console.log("✅ DataSocket connected");
      if (this.pendingSubs.size) {
        const list = Array.from(this.pendingSubs);
        this.skt.subscribe(list);
        console.log("Subscribed (flush):", list);
      }
    });

    this.skt.on("message", (raw: any) => {
      try {
        const msg = typeof raw === "string" ? JSON.parse(raw) : raw;
        const ticks = Array.isArray(msg?.d) ? msg.d : [msg];
        for (const t of ticks) {
          const symbol = t.symbol || t.n;
          const ltp = t.ltp || t?.v?.lp;
          if (!symbol || !ltp) continue;
          const { getMachineBySymbol } = require("./machineRegistry");
          const m = getMachineBySymbol(symbol);
          if (m) m.onTick(Number(ltp));
        }
      } catch {}
    });

    this.skt.on("error", (e: any) => console.error("❌ DataSocket error:", e));
    this.skt.on("close", () => console.log("🔌 DataSocket closed"));

    this.skt.connect();
    this.skt.autoreconnect();
  }

  subscribe(symbols: string[]) {
    if (!symbols?.length) return;
    for (const s of symbols) this.pendingSubs.add(s);
    if (this.skt && this.skt.isConnected && this.skt.isConnected()) {
      this.skt.subscribe(symbols);
      console.log("Subscribed:", symbols);
    }
  }
}

export const socketManager = new SocketManager();
