type CP = "C" | "P";

const MONTH_3 = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const MONTH_1 = ["J","F","M","A","M","J","J","A","S","O","N","D"]; // NOV -> 'N'

/**
 * Your mapping rules:
 * - NIFTY weekly → NSE:NIFTY<YY><M><DD><STRIKE><CE|PE>
 *   e.g. NIFTY251111C25700 -> NSE:NIFTY25N1125700CE
 * - BANKNIFTY monthly → NSE:BANKNIFTY<YY><MON><STRIKE><CE|PE>
 *   e.g. BANKNIFTY251125C59500 -> NSE:BANKNIFTY25NOV59500CE
 */
export function formatFyersSymbol(
  underlying: string,
  yy: string,
  mm: string,
  dd: string,
  cp: CP,
  strike: number
): string {
  const monIdx = Number(mm) - 1;
  if (monIdx < 0 || monIdx > 11) throw new Error(`Invalid month: ${mm}`);

  const optType = cp === "C" ? "CE" : "PE";

  if (underlying === "NIFTY") {
    const m1 = MONTH_1[monIdx]; // 'N' for NOV
    return `NSE:${underlying}${yy}${m1}${dd}${strike}${optType}`;
  }
  if (underlying === "BANKNIFTY") {
    const m3 = MONTH_3[monIdx]; // 'NOV'
    return `NSE:${underlying}${yy}${m3}${strike}${optType}`;
  }

  // fallback: NIFTY-style
  const m1 = MONTH_1[monIdx];
  return `NSE:${underlying}${yy}${m1}${dd}${strike}${optType}`;
}
