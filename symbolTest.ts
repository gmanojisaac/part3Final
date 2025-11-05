import { formatFyersSymbol } from "./server/symbolFormat";

// NIFTY (weekly)
console.log(
  formatFyersSymbol("NIFTY","25","11","11","C",25700)
); // NSE:NIFTY25N1125700CE

console.log(
  formatFyersSymbol("NIFTY","25","11","11","P",25550)
); // NSE:NIFTY25N1125550PE

// BANKNIFTY (monthly)
console.log(
  formatFyersSymbol("BANKNIFTY","25","11","25","C",59500)
); // NSE:BANKNIFTY25NOV59500CE

console.log(
  formatFyersSymbol("BANKNIFTY","25","11","25","P",56600)
); // NSE:BANKNIFTY25NOV56600PE
