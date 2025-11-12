// server/symbolFormat.ts

export type ParsedWebhookSym = {
  root: "NIFTY" | "BANKNIFTY";
  yy: string; // "25"
  mm: string; // "11"
  dd: string; // "18"
  cp: "C" | "P";
  strike: string; // "25650"
};

const MONTH_LETTER: Record<string, string> = {
  "01": "A", // Jan
  "02": "F", // Feb
  "03": "M", // Mar
  "04": "A", // Apr
  "05": "M", // May
  "06": "J", // Jun
  "07": "J", // Jul
  "08": "A", // Aug
  "09": "S", // Sep
  "10": "O", // Oct
  "11": "N", // Nov
  "12": "D", // Dec
};

const RE = /\b(NIFTY|BANKNIFTY)(\d{2})(\d{2})(\d{2})([CP])(\d+)\b/i;

export function parseWebhookSym(raw: string): { fyers: string; underlying: "NIFTY" | "BANKNIFTY" } {
  const m = raw.trim().toUpperCase().match(RE);
  if (!m) throw new Error(`symbolFormat: cannot parse "${raw}"`);

  const root = m[1] as "NIFTY" | "BANKNIFTY";
  const yy = m[2];
  const mm = m[3];
  const dd = m[4];
  const cp = m[5] as "C" | "P";
  const strike = m[6];

  const mon = MONTH_LETTER[mm];
  if (!mon) throw new Error(`symbolFormat: unknown month "${mm}" in "${raw}"`);

  const suffix = cp === "C" ? "CE" : "PE";
  const fyers = `NSE:${root}${yy}${mon}${dd}${strike}${suffix}`;

  return { fyers, underlying: root };
}

/** Back-compat helper */
export function formatSymbol(raw: string) {
  const { fyers, underlying } = parseWebhookSym(raw);
  return { fySymbol: fyers, underlying };
}
