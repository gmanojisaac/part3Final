// server/parseWebhook.ts
import { formatFyersSymbol } from "./symbolFormat";

export type ParsedSignal = {
  raw: string;
  action: "ENTRY" | "EXIT";
  stopPx?: number;
  srcSymbol: string;
  fyersSymbol: string;
  meta: {
    underlying: string; yy: string; mm: string; dd: string;
    cp: "C" | "P"; strike: number;
  };
};

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

export function parseWebhookLine(line: string): ParsedSignal {
  const action = /Accepted\s+(Entry|Exit)/i.test(line)
    ? (/Entry/i.test(line) ? "ENTRY" : "EXIT")
    : (() => { throw new Error("Cannot find action (Entry/Exit)"); })();

  const stopMatch = line.match(/stopPx\s*=\s*([0-9]*\.?[0-9]+)/i);
  const stopPx = stopMatch ? Number(stopMatch[1]) : undefined;

  // sym=UNDERLYING YY MM DD C|P STRIKE  e.g. NIFTY251111C25000
  const m = line.match(/sym=([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d+)/);
  if (!m) throw new Error("Cannot parse sym= token");

  const [, underlying, yy, mm, dd, cp, strikeStr] = m;
  const monIdx = Number(mm) - 1;
  if (monIdx < 0 || monIdx > 11) throw new Error("Invalid month in sym");
  const strike = Number(strikeStr);

  const fyersSymbol = formatFyersSymbol(
    underlying, yy, mm, dd, cp as "C" | "P", strike
  );

  return {
    raw: line,
    action,
    stopPx,
    srcSymbol: `${underlying}${yy}${mm}${dd}${cp}${strike}`,
    fyersSymbol,
    meta: { underlying, yy, mm, dd, cp: cp as "C" | "P", strike }
  };
}
