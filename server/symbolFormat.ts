// server/symbolFormat.ts
// Convert from webhook "NIFTY251111C25000" etc. to FYERS symbols:
// NIFTY -> NIFTY25N11<strike>CE  (YY M(D=1..31) Day? In Fyers options it's DD + month code)
// BANKNIFTY -> BANKNIFTY25NOV<strike>CE

const MONTH_CODE = ["", "F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X"]; // Fyers short? We used 'N' for Nov (given by you)
const MON_FULL = ["", "JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

export function parseWebhookSym(s: string) {
  // Examples:
  // NIFTY251111C25000 → underlying=NIFTY, yy=25, mm=11, dd=11, C/P, strike=25000
  // BANKNIFTY251125C59500
  const m = s.match(/^(NIFTY|BANKNIFTY)(\d{2})(\d{2})(\d{2})([CP])(\d+)$/i);
  if (!m) throw new Error(`Unrecognized sym: ${s}`);
  const underlying = m[1].toUpperCase();
  const yy = m[2];
  const mm = Number(m[3]);
  const dd = m[4];
  const cp = m[5].toUpperCase();
  const strike = m[6];

  if (underlying === "NIFTY") {
    // NIFTY25N1125000CE (YY M(Day)?? per your mapping we used "N" for November and day DD)
    const monLetter = "FGHJKMNQUVX"[mm - 1] || "N"; // fallback N
    return {
      fyers: `NSE:NIFTY${yy}${monLetter}${dd}${strike}${cp}E`,
      underlying,
    };
  } else {
    // BANKNIFTY25NOV59500CE (YY MON strike CE)
    const mon = MON_FULL[mm];
    return {
      fyers: `NSE:BANKNIFTY${yy}${mon}${strike}${cp}E`,
      underlying,
    };
  }
}
