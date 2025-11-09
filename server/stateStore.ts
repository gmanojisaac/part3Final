// server/stateStore.ts
import fs from "fs";
import path from "path";

const DATA_DIR = path.resolve(__dirname, "../data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILE = path.join(DATA_DIR, "machines.json");

export type PersistedMachine = {
  symbol: string;
  underlying: string;
  state: string;
  prevSavedLTP?: number | null;
  buySignalAt?: number | null;
  reentryDeadline?: number | null;
  rollingActive?: boolean;
  cancelReentryDueToSell?: boolean;
  sellArmed?: boolean;
  sellArmRefLTP?: number | null;
  entryOrderId?: string;
  entryRefLTP?: number | null;
  slPoints?: number;
  orderValue?: number;
};

type FileShape = Record<string, any>;

function read(): FileShape {
  try {
    if (!fs.existsSync(FILE)) return {};
    const raw = fs.readFileSync(FILE, "utf8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function write(obj: FileShape) {
  fs.writeFileSync(FILE, JSON.stringify(obj, null, 2));
}

export function upsert(m: any) {
  const db = read();
  db[m.symbol] = m;
  write(db);
}

export function loadAll(): any[] {
  const db = read();
  return Object.values(db) as any[];
}

export function clearAll() {
  write({});
}
