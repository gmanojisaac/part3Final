// server/relayStore.ts
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const RELAY_FILE = path.join(DATA_DIR, "relays.json");

type RelayList = string[];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load(): RelayList {
  try {
    ensureDataDir();
    if (!fs.existsSync(RELAY_FILE)) return [];
    const raw = fs.readFileSync(RELAY_FILE, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function save(list: RelayList) {
  ensureDataDir();
  fs.writeFileSync(RELAY_FILE, JSON.stringify(list, null, 2), "utf8");
}

let relays = new Set<string>(load());

function normalize(url: string): string {
  return url.trim();
}
function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function getRelays(): string[] {
  return Array.from(relays);
}

export function addRelay(url: string): { ok: true } | { ok: false; error: string } {
  const u = normalize(url);
  if (!isValidUrl(u)) return { ok: false, error: "Invalid URL. Must start with http:// or https://" };
  relays.add(u);
  save(getRelays());
  return { ok: true };
}

export function removeRelay(url: string) {
  const u = normalize(url);
  relays.delete(u);
  save(getRelays());
}

export function clearRelays() {
  relays.clear();
  save(getRelays());
}
