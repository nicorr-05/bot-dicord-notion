/**
 * Weekly scheduling in a fixed timezone, without a cron dependency.
 *
 * Node's timers are UTC-based, so "viernes 3:30 PM en Caracas" has to be turned
 * into an instant by hand. Every conversion goes through Intl and re-reads the
 * zone offset at the target instant, so a zone that does observe DST keeps
 * landing on the right side of the change instead of drifting an hour twice a
 * year. Venezuela doesn't, but the bot shouldn't depend on that.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Spanish spellings accepted in WEEKLY_DIGEST_WEEKDAY, mapped to Intl's names. */
const WEEKDAY_ALIASES = {
  domingo: "Sun",
  lunes: "Mon",
  martes: "Tue",
  miercoles: "Wed",
  jueves: "Thu",
  viernes: "Fri",
  sabado: "Sat",
};

const MS_PER_DAY = 86_400_000;

/** Intl formatters are expensive to build and always reused for the same zone. */
const formatters = new Map();

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      // h23 instead of hour12:false — the latter reports midnight as hour "24".
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall clock in `timeZone` at a given instant. */
export function zonedParts(date, timeZone) {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
  };
}

/** Offset of `timeZone` from UTC, in ms, at a given instant. */
function offsetMsAt(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asIfUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // The parts carry no milliseconds, so compare against a whole second.
  return asIfUTC - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant at which the wall clock in `timeZone` reads the given local time. */
export function instantOf({ year, month, day, hour, minute }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Two passes: the first uses the offset around that wall time, the second
  // re-reads it at the instant that produced — which is what gets DST right.
  const firstPass = naive - offsetMsAt(new Date(naive), timeZone);
  return naive - offsetMsAt(new Date(firstPass), timeZone);
}

/** YYYY-MM-DD of an instant as seen in `timeZone` — the shape Notion dates use. */
export function zonedDateKey(date, timeZone) {
  const { year, month, day } = zonedParts(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Shifts a YYYY-MM-DD key by whole days, staying in date-only space. */
export function shiftDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * MS_PER_DAY);
  return shifted.toISOString().slice(0, 10);
}

/** Normalizes "Fri" / "friday" / "viernes" / "5" into Intl's short weekday name. */
export function parseWeekday(value, fallback = "Fri") {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;

  if (/^\d$/.test(raw)) return WEEKDAYS[Number(raw) % 7];

  const normalized = raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

  const alias = WEEKDAY_ALIASES[normalized];
  if (alias) return alias;

  const short = normalized.slice(0, 3);
  const match = WEEKDAYS.find((d) => d.toLowerCase() === short);
  return match ?? fallback;
}

/** Parses "15:30" into {hour, minute}, falling back when the value is unusable. */
export function parseTimeOfDay(value, fallback = { hour: 15, minute: 30 }) {
  const match = String(value ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return fallback;

  return { hour, minute };
}

/**
 * The next time the wall clock in `timeZone` reads `weekday` at `hour:minute`,
 * strictly after `from`.
 */
export function nextWeeklyOccurrence({ weekday, hour, minute, timeZone }, from = new Date()) {
  // Walk forward a day at a time in the target zone: i === 0 covers "today, still
  // to come" and i === 7 covers "today, already passed".
  for (let i = 0; i <= 7; i++) {
    const probe = new Date(from.getTime() + i * MS_PER_DAY);
    const parts = zonedParts(probe, timeZone);
    if (parts.weekday !== weekday) continue;

    const instant = instantOf({ ...parts, hour, minute }, timeZone);
    if (instant > from.getTime()) return new Date(instant);
  }

  throw new Error(
    `No se pudo calcular el próximo ${weekday} ${hour}:${minute} en ${timeZone}`
  );
}

/** The most recent time that schedule fired, at or before `from`. */
export function lastWeeklyOccurrence(spec, from = new Date()) {
  const next = nextWeeklyOccurrence(spec, from);
  // One week back from the next firing is the previous one, DST included: the
  // wall-clock time is recomputed rather than subtracted.
  const aWeekEarlier = new Date(next.getTime() - 7 * MS_PER_DAY - 1);
  return nextWeeklyOccurrence(spec, aWeekEarlier);
}

/**
 * Runs `task` every week at the given local time. Re-arms after each run, so a
 * long-running task can't make the schedule drift.
 * @returns {{next: Date, stop: () => void}}
 */
export function scheduleWeekly(spec, task) {
  let timer = null;

  const arm = () => {
    const next = nextWeeklyOccurrence(spec);
    timer = setTimeout(async () => {
      try {
        await task(next);
      } catch (error) {
        console.error("[Schedule] La tarea semanal falló:", error.message);
      }
      arm();
    }, next.getTime() - Date.now());
    timer.unref?.();
    return next;
  };

  return { next: arm(), stop: () => clearTimeout(timer) };
}
