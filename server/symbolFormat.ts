// server/symbolFormat.ts
type CP = "C" | "P";

const MONTH_3 = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const MONTH_1 = ["J","F","M","A","M","J","J","A","S","O","N","D"]; // NOV -> 'N'

/**
 * Rules:
 * - NIFTY weekly → NSE:NIFTY<YY><M><DD><STRIKE><CE|PE>
 *   Example: NIFTY251111C25700 -> NSE:NIFTY25N1125700CE
 *
 * - BANKNIFTY monthly → NSE:BANKNIFTY<YY><MON><STRIKE><CE|PE>
 *   Example: BANKNIFTY251125C59500 -> NSE:BANKNIFTY25NOV59500CE
 */
export function formatFyersSymbol(
  underlying: string, // "NIFTY" | "BANKNIFTY"
  yy: string,         // "25"
  mm: string,         // "11"
  dd: string,         // "11" or "25"
  cp: CP,             // "C" | "P"
  strike: number      // e.g. 25700
): string {
  const monIdx = Number(mm) - 1;
  if (monIdx < 0 || monIdx > 11) throw new Error(`Invalid month: ${mm}`);

  const optType = cp === "C" ? "CE" : "PE";

  if (underlying === "NIFTY") {
    // YY + single-letter month + DD
    const m1 = MONTH_1[monIdx]; // 'N' for NOV
    return `NSE:${underlying}${yy}${m1}${dd}${strike}${optType}`;
  }

  if (underlying === "BANKNIFTY") {
    // YY + 3-letter month
    const m3 = MONTH_3[monIdx]; // 'NOV'
    return `NSE:${underlying}${yy}${m3}${strike}${optType}`;
  }

  // Fallback: use NIFTY weekly style
  const m1 = MONTH_1[monIdx];
  return `NSE:${underlying}${yy}${m1}${dd}${strike}${optType}`;
}
