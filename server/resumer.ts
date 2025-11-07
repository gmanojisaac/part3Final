// server/resumer.ts
import { getPositionsV3, getQuotesV3 } from "./fyersClient";
import { loadAll } from "./stateStore";
import { TradeStateMachine } from "./stateMachine";
import { setMachine } from "./machineRegistry";
import { socketManager } from "./dataSocket";

export async function resumeAllMachines() {
  // Allow skip via env
  if ((process.env.FRESH_START || "").trim() === "1") {
    console.log("[RESUME] Skipped due to FRESH_START=1");
    return;
  }

  const persisted = loadAll();
  if (!persisted.length) {
    console.log("[RESUME] No machines found in state file. Skipping.");
    return;
  }

  const local = new Map<string, TradeStateMachine>();

  // 1) Rehydrate from disk and subscribe symbols
  for (const p of persisted) {
    const m = TradeStateMachine.fromPersisted(p);
    setMachine(p.symbol, m);
    local.set(p.symbol, m);
    try {
      socketManager.subscribe([p.symbol]);
      console.log("Subscribed (resume):", p.symbol);
    } catch (e) {
      console.warn("Subscribe failed during resume:", p.symbol, e);
    }
  }

  // 2) Reconcile with broker positions (best-effort)
  try {
    const pos = await getPositionsV3(); // normalized { s, netPositions }
    const net = Array.isArray(pos?.netPositions) ? pos.netPositions : [];
    const liveLong = new Set<string>();

    for (const row of net) {
      const sym: string = row?.symbol || row?.tradingsymbol;
      const qty: number = Number(row?.qty ?? row?.netQty ?? row?.net_qty ?? 0);
      if (sym && qty > 0) liveLong.add(sym);
    }

    for (const p of persisted) {
      const sym = p.symbol;
      const m = local.get(sym);
      if (!m) continue;

      if (liveLong.has(sym)) {
        if (m.getState() !== "LONG_ACTIVE") m.onEntryFilled();
        const needsPrev = (m as any).prevSavedLTP == null;
        const needsEntryRef = (m as any).entryRefLTP == null;
        if (needsPrev || needsEntryRef) {
          try {
            const q = await getQuotesV3([sym]);
            const lp = q?.d?.[0]?.v?.lp;
            if (lp) {
              if (needsPrev) (m as any).prevSavedLTP = lp;
              if (needsEntryRef) (m as any).entryRefLTP = lp;
              (m as any).persist?.();
              console.log(`[RESUME] Seeded baselines for ${sym}: prevSavedLTP=${lp}, entryRefLTP=${lp}`);
            }
          } catch {}
        }
      } else {
        if (m.getState() !== "IDLE") {
          (m as any).state = "IDLE";
          (m as any).entryOrderId = undefined;
          (m as any).entryRefLTP = null;
          (m as any).persist?.();
          console.log(`[RESUME] Forced flat state for ${sym} (no live position).`);
        }
      }
    }
  } catch (e) {
    console.warn("resumeAllMachines: positions fetch failed, continuing with disk state only.", e);
  }
}
