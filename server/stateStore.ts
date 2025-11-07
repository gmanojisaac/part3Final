// server/stateStore.ts
import fs from "fs";
import path from "path";

const STORE = path.resolve(__dirname, "../data/state.json");

export interface PersistedMachine {
  symbol: string;
  underlying: string;
  state: "IDLE" | "PENDING_ENTRY" | "LONG_ACTIVE";
  prevSavedLTP: number | null;
  buySignalAt: number | null;
  reentryDeadline: number | null;
  rollingActive: boolean;
  cancelReentryDueToSell: boolean;
  sellArmed: boolean;
  sellArmRefLTP: number | null;
  entryOrderId?: string;
  entryRefLTP: number | null;
  slPoints: number;
  orderValue: number;
}

function ensureDir() {
  const dir = path.dirname(STORE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(STORE)) fs.writeFileSync(STORE, "[]");
}

export function loadAll(): PersistedMachine[] {
  try {
    ensureDir();
    const raw = fs.readFileSync(STORE, "utf8");
    return JSON.parse(raw || "[]");
  } catch {
    return [];
  }
}

export function saveAll(list: PersistedMachine[]) {
  ensureDir();
  fs.writeFileSync(STORE, JSON.stringify(list, null, 2));
}

export function upsert(one: PersistedMachine) {
  const all = loadAll();
  const i = all.findIndex(x => x.symbol === one.symbol);
  if (i >= 0) all[i] = one; else all.push(one);
  saveAll(all);
}

export function remove(symbol: string) {
  const all = loadAll().filter(x => x.symbol !== symbol);
  saveAll(all);
}
