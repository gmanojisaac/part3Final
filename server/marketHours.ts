// server/marketHours.ts
// Market-hours helpers with Asia/Kolkata (IST) clock.
// Defaults: Mon–Fri, 09:15–15:30 IST. Configurable via env.

type ClockInfo = {
  nowIST: string;           // "YYYY-MM-DD HH:mm:ss"
  weekday: string;          // "Mon".."Sun"
  open: boolean;            // within window?
  start: string;            // "HH:mm"
  end: string;              // "HH:mm"
  minutesToOpen: number;    // -1 if already open today or today closed
  minutesToClose: number;   // -1 if already closed (or not yet open)
  todayHoliday: boolean;
};

const TZ = "Asia/Kolkata";

function fmtTwo(n: number) { return n < 10 ? `0${n}` : String(n); }

function getISTParts(d = new Date()) {
  // robust way to read IST without changing process TZ
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {} as Record<string,string>);

  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    hh: Number(parts.hour),
    mm: Number(parts.minute),
    ss: Number(parts.second),
    wd: parts.weekday, // Mon, Tue, ...
  };
}

function parseHHMM(s: string, def: string): number {
  const t = (s || def).trim();
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    const [hh, mm] = def.split(":").map(Number);
    return hh * 60 + mm;
  }
  const hh = Math.max(0, Math.min(23, Number(m[1])));
  const mm = Math.max(0, Math.min(59, Number(m[2])));
  return hh * 60 + mm;
}

function todayKeyIST(): string {
  const p = getISTParts();
  return `${p.y}-${fmtTwo(p.m)}-${fmtTwo(p.d)}`;
}

function parseHolidaysEnv(): Set<string> {
  // MARKET_HOLIDAYS=2025-11-14,2025-12-25
  const raw = (process.env.MARKET_HOLIDAYS || "").trim();
  if (!raw) return new Set();
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

export function isMarketOpen(): boolean {
  // Hard overrides for testing
  const forceOpen = (process.env.FORCE_MARKET_OPEN || "").toLowerCase() === "true";
  const forceClosed = (process.env.FORCE_MARKET_CLOSED || "").toLowerCase() === "true";
  if (forceOpen && !forceClosed) return true;
  if (forceClosed && !forceOpen) return false;

  const p = getISTParts();
  const dayMap: Record<string, number> = { Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6, Sun:7 };
  const weekday = dayMap[p.wd] || 0;

  // MARKET_DAYS default "1-5" → Mon..Fri. You can set "1,2,3,4,5" or "2-6" etc.
  const md = (process.env.MARKET_DAYS || "1-5").trim();
  const allowed = new Set<number>();
  for (const chunk of md.split(",")) {
    const c = chunk.trim();
    if (!c) continue;
    const r = c.match(/^(\d)-(\d)$/);
    if (r) {
      const a = Number(r[1]), b = Number(r[2]);
      for (let x = Math.min(a,b); x <= Math.max(a,b); x++) allowed.add(x);
    } else {
      allowed.add(Number(c));
    }
  }
  if (!allowed.has(weekday)) return false;

  // Holidays
  const holidays = parseHolidaysEnv();
  if (holidays.has(todayKeyIST())) return false;

  // Window
  const startMin = parseHHMM(process.env.MARKET_START || "", "09:15");
  const endMin   = parseHHMM(process.env.MARKET_END   || "", "15:30");
  const nowMin   = p.hh * 60 + p.mm;

  return nowMin >= startMin && nowMin <= endMin;
}

export function marketClock(): ClockInfo {
  const p = getISTParts();
  const start = (process.env.MARKET_START || "09:15").trim();
  const end   = (process.env.MARKET_END   || "15:30").trim();
  const startMin = parseHHMM(start, "09:15");
  const endMin   = parseHHMM(end, "15:30");
  const nowMin   = p.hh * 60 + p.mm;

  const dayMap: Record<string, number> = { Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6, Sun:7 };
  const weekdayNum = dayMap[p.wd] || 0;

  const md = (process.env.MARKET_DAYS || "1-5").trim();
  const allowed = new Set<number>();
  for (const chunk of md.split(",")) {
    const c = chunk.trim();
    if (!c) continue;
    const r = c.match(/^(\d)-(\d)$/);
    if (r) {
      const a = Number(r[1]), b = Number(r[2]);
      for (let x = Math.min(a,b); x <= Math.max(a,b); x++) allowed.add(x);
    } else {
      allowed.add(Number(c));
    }
  }

  const todayHoliday = parseHolidaysEnv().has(todayKeyIST());
  const withinDays = allowed.has(weekdayNum);
  const withinWindow = nowMin >= startMin && nowMin <= endMin;
  const forceOpen = (process.env.FORCE_MARKET_OPEN || "").toLowerCase() === "true";
  const forceClosed = (process.env.FORCE_MARKET_CLOSED || "").toLowerCase() === "true";
  const open = forceOpen ? true : forceClosed ? false : (withinDays && !todayHoliday && withinWindow);

  let minutesToOpen = -1;
  let minutesToClose = -1;
  if (!open && withinDays && !todayHoliday && nowMin < startMin) {
    minutesToOpen = startMin - nowMin;
  } else if (open) {
    minutesToClose = Math.max(0, endMin - nowMin);
  }

  const nowIST = `${p.y}-${fmtTwo(p.m)}-${fmtTwo(p.d)} ${fmtTwo(p.hh)}:${fmtTwo(p.mm)}:${fmtTwo(p.ss)}`;
  return { nowIST, weekday: p.wd, open, start, end, minutesToOpen, minutesToClose, todayHoliday };
}
