// fyersClient.ts — universal FYERS history wrapper (SDK or REST fallback)
import fs from "node:fs";
import path from "node:path";

// -------- Token resolution --------
function resolveAccessToken(): string {
  let tok = (process.env.FYERS_ACCESS_TOKEN || "").trim();

  if (!tok) {
    const p = path.resolve(process.cwd(), "fyers_token.txt");
    if (fs.existsSync(p)) tok = fs.readFileSync(p, "utf8").trim();
  }
  if (!tok) throw new Error("No FYERS access token found. Set FYERS_ACCESS_TOKEN or create fyers_token.txt.");

  const rawMode = /^true$/i.test((process.env.RAW_TOKEN_MODE || "").trim());
  if (!rawMode && !/^Bearer\s+/i.test(tok)) tok = `Bearer ${tok}`;
  return tok;
}

// -------- Types --------
export type HistoryInput = {
  symbol: string;
  resolution: "1" | "3" | "5" | "15" | "30" | "60" | "D";
  date_format: "0" | "1";
  range_from: string; // unix seconds
  range_to: string;   // unix seconds
  cont_flag?: "1" | "0";
};

type SDKHistoryFn = (inp: HistoryInput) => Promise<any>;

let cachedSdkCaller: SDKHistoryFn | null = null;

// -------- REST fallback --------
async function getHistoryREST(inp: HistoryInput, token: string): Promise<any> {
  const base = (process.env.FYERS_HISTORY_BASE || "https://api.fyers.in/data-rest/v2/history/").replace(/\/+$/, "/");
  const url =
    `${base}?symbol=${encodeURIComponent(inp.symbol)}` +
    `&resolution=${encodeURIComponent(inp.resolution)}` +
    `&date_format=${inp.date_format}` +
    `&range_from=${encodeURIComponent(inp.range_from)}` +
    `&range_to=${encodeURIComponent(inp.range_to)}` +
    `&cont_flag=${inp.cont_flag ?? "1"}`;

  const res = await fetch(url, { headers: { Authorization: token, "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(`REST history fetch failed ${res.status} ${await res.text().catch(()=> "")}`);
  return res.json();
}

// -------- SDK loader (try many shapes) --------
function buildSdkCaller(token: string): SDKHistoryFn | null {
  let mod: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require("fyers-api-v3");
  } catch {
    return null;
  }

  // candidate A: module is the client itself
  if (mod && typeof mod.setAccessToken === "function") {
    const client = mod;
    try { client.setAccessToken(token); } catch {}
    if (typeof client.getHistory === "function") return (inp) => client.getHistory(inp);
    if (typeof client.history === "function")    return (inp) => client.history(inp);
    if (typeof client.getHistoryData === "function") return (inp) => client.getHistoryData(inp);
  }

  // candidate B: named class FyersModel
  if (mod?.FyersModel) {
    const client = new mod.FyersModel();
    if (typeof client.setToken === "function") client.setToken(token);
    else if (typeof client.setAccessToken === "function") client.setAccessToken(token);

    if (typeof client.getHistory === "function") return (inp) => client.getHistory(inp);
    if (typeof client.history === "function")    return (inp) => client.history(inp);
    if (typeof client.getHistoryData === "function") return (inp) => client.getHistoryData(inp);
  }

  // candidate C: default export being a class/function
  if (typeof mod === "function") {
    const client = new mod();
    if (typeof client.setToken === "function") client.setToken(token);
    else if (typeof client.setAccessToken === "function") client.setAccessToken(token);

    if (typeof client.getHistory === "function") return (inp) => client.getHistory(inp);
    if (typeof client.history === "function")    return (inp) => client.history(inp);
    if (typeof client.getHistoryData === "function") return (inp) => client.getHistoryData(inp);
  }

  return null;
}

// -------- Public: universal getHistory() --------
export async function getHistory(inp: HistoryInput): Promise<any> {
  const token = resolveAccessToken();

  // try cached sdk caller first
  if (cachedSdkCaller) {
    try { return await cachedSdkCaller(inp); } catch {/* fall back */ }
  }

  // build (or rebuild) sdk caller
  cachedSdkCaller = buildSdkCaller(token);

  if (cachedSdkCaller) {
    try { return await cachedSdkCaller(inp); } catch {/* fall back to REST */ }
  }

  // REST fallback (works regardless of SDK)
  return getHistoryREST(inp, token);
}
