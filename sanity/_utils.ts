// sanity/_utils.ts
import dotenv from "dotenv";
dotenv.config();

const BASE = process.env.BASE || "http://localhost:3000";

export async function http(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: any,
  contentType?: string
) {
  const url = `${BASE}${path}`;
  const headers: Record<string, string> = {};
  let payload: any = undefined;

  if (body !== undefined) {
    if (typeof body === "string" && contentType?.startsWith("text/")) {
      headers["content-type"] = contentType;
      payload = body;
    } else {
      headers["content-type"] = contentType || "application/json";
      payload = typeof body === "string" ? body : JSON.stringify(body);
    }
  }

  const res = await fetch(url, { method, headers, body: payload as any });
  const text = await res.text();
  let json: any = undefined;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, text, url };
}

export function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function log(title: string, data: any) {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}] ${title}`, data ?? "");
}

export function baseUrl() { return BASE; }
