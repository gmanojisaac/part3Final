// server/resumer.ts
import { loadAll } from "./stateStore";
import { TradeStateMachine } from "./stateMachine";
import { subscribe } from "./dataSocket";

export function resumeAllMachines() {
  const rows = loadAll();
  for (const r of rows) {
    try {
      const m = TradeStateMachine.fromPersisted(r);
      subscribe(r.symbol);
    } catch (e) {
      console.warn("resume error:", e);
    }
  }
  console.log("Resume done.");
}
