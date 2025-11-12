/* eslint-disable no-console */

/**
 * NSE regular trading hours helper.
 * - Market open: Monday–Friday, 09:15 to 15:30 IST (Asia/Kolkata)
 * - Holidays are NOT encoded here (treat them as closed if you add a calendar).
 *
 * Exports:
 *   - isMarketOpenNow(): boolean
 *   - isMarketOpenAt(date: Date): boolean
 *   - isMarketOpen(): boolean              // legacy alias for webhookHandler
 *   - setMarketOpenOverride(value: boolean | null): void
 *   - marketClock(): { isMarketOpenNow, isMarketOpenAt, setMarketOpenOverride }
 */

let overrideOpen: boolean | null = null;

export function setMarketOpenOverride(value: boolean | null) {
  overrideOpen = value;
}

export function isMarketOpenNow(): boolean {
  return isMarketOpenAt(new Date());
}

/** Legacy alias expected by webhookHandler */
export function isMarketOpen(): boolean {
  return isMarketOpenNow();
}

export function isMarketOpenAt(utcDate: Date): boolean {
  if (overrideOpen !== null) return overrideOpen;

  const parts = toIstParts(utcDate);
  const dow = parts.weekday; // 0..6  (Sun..Sat)

  if (dow === 0 || dow === 6) return false;

  const minutes = parts.hour * 60 + parts.minute;
  const openMin = 9 * 60 + 15;   // 09:15
  const closeMin = 15 * 60 + 30; // 15:30

  return minutes >= openMin && minutes <= closeMin;
}

function toIstParts(d: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = fmt.formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "0";

  const weekdayStr = get("weekday"); // "Mon".."Sun"
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayStr);

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday,
  };
}

/** Callable facade expected by server/index.ts */
export function marketClock() {
  return {
    isMarketOpenNow,
    isMarketOpenAt,
    setMarketOpenOverride,
  };
}
