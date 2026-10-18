// Timezone math for the reminders subsystem.
//
// Everything here is pure and dependency-free: it only uses the platform
// `Intl.DateTimeFormat` with an explicit `timeZone`, which the Workers runtime
// supports. The Worker's own clock is UTC and is NEVER treated as the user's
// local time — every conversion goes through an explicit IANA zone that was
// either stored on the user record or explicitly confirmed by the user.
//
// Two invariants this module exists to protect:
//   1. A wall-clock time the user typed is only meaningful together with a
//      zone. `resolveLocalToUtc` is the single place that conversion happens.
//   2. Local wall clocks are not a bijection onto UTC instants. During a DST
//      spring-forward some local times do not exist, and during a fall-back
//      some happen twice. Both are reported rather than silently guessed.

const OFFSET_SAMPLE_MS = 24 * 60 * 60 * 1000;
const TZ_NAME_MAX = 64;

const formatterCache = new Map();

function baseFormatter(timeZone) {
  let fmt = formatterCache.get(timeZone);
  if (fmt) return fmt;
  fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  formatterCache.set(timeZone, fmt);
  return fmt;
}

/**
 * True when `tz` is a usable IANA zone name. Rejects anything that is not a
 * short, printable zone-shaped string before handing it to `Intl`, so a
 * malformed value can never reach the formatter in a hot path.
 */
export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== "string") return false;
  const name = tz.trim();
  if (!name || name.length > TZ_NAME_MAX) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(name)) return false;
  try {
    baseFormatter(name).format(new Date(0));
    return true;
  } catch (err) {
    return false;
  }
}

/** Calendar helper: days since 1970-01-01 for a Gregorian y/m/d. */
function daysFromCivil(y, m, d) {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor((yy >= 0 ? yy : yy - 399) / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * Build a UTC epoch (ms) from UTC calendar parts.
 *
 * `Date.UTC` maps years 0..99 into 1900..1999, which would turn a parsed
 * "99/5/12" into the wrong century. Setting the full year explicitly avoids
 * that trap.
 */
export function utcFromParts(y, mo, d, h, mi, s) {
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(h || 0, mi || 0, s || 0, 0);
  return dt.getTime();
}

/**
 * Fold an out-of-range wall clock back onto the calendar.
 *
 * Callers do integer arithmetic on calendar fields, so `month 13`, `day 32`,
 * `hour 25` and `day -3` all arrive here legitimately. `Date`'s own setters
 * already carry overflow the way a human would ("Jan 32" is "Feb 1"), so this
 * just borrows that instead of reimplementing it.
 */
function normalizeWallClock(y, mo, d, h, mi, s) {
  const dt = new Date(0);
  dt.setUTCFullYear(Number(y) || 1970, (Number(mo) || 1) - 1, Number(d) || 1);
  dt.setUTCHours(Number(h) || 0, Number(mi) || 0, Number(s) || 0, 0);
  if (!Number.isFinite(dt.getTime())) {
    // Absurd input (a year of 1e9). Clamp rather than let NaN leak into the
    // offset sampling below, which would masquerade as a DST gap.
    return { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  }
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
    hour: dt.getUTCHours(),
    minute: dt.getUTCMinutes(),
    second: dt.getUTCSeconds()
  };
}

/** Day of week for a Gregorian date: 0 = Sunday … 6 = Saturday. */
export function weekdayOf(y, mo, d) {
  return ((daysFromCivil(y, mo, d) + 4) % 7 + 7) % 7;
}
/** Number of days in a Gregorian month (1-based month). */
export function daysInGregorianMonth(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/**
 * The wall-clock parts a given UTC instant shows in `tz`.
 *
 * Seconds are included because some zones have a non-whole-minute offset in
 * historical data; comparisons below use the seconds field, not just h/m.
 */
export function zonedParts(ms, tz) {
  const parts = baseFormatter(tz).formatToParts(new Date(ms));
  const o = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].type !== "literal") o[parts[i].type] = parts[i].value;
  }
  return {
    year: parseInt(o.year, 10),
    month: parseInt(o.month, 10),
    day: parseInt(o.day, 10),
    hour: parseInt(o.hour, 10) % 24,
    minute: parseInt(o.minute, 10),
    second: parseInt(o.second, 10),
    weekday: weekdayOf(parseInt(o.year, 10), parseInt(o.month, 10), parseInt(o.day, 10))
  };
}

/** Offset of `tz` from UTC at `ms`, in milliseconds (east positive). */
export function tzOffsetMs(ms, tz) {
  const p = zonedParts(ms, tz);
  return utcFromParts(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** Offset of `tz` from UTC at `ms`, in minutes (east positive). */
export function tzOffsetMinutes(ms, tz) {
  return Math.round(tzOffsetMs(ms, tz) / 60000);
}

function sameWallClock(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day &&
    a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

/**
 * Convert a local wall clock in `tz` to a UTC instant.
 *
 * Returns one of:
 *   { kind: "exact",        ms, offsetMinutes }
 *   { kind: "ambiguous",    ms, offsetMinutes, alternatives: [ms, ms] }
 *   { kind: "nonexistent",  suggestionMs, gapMinutes }   // DST spring-forward
 *
 * `ambiguous` (a repeated hour when DST ends) resolves to the FIRST occurrence,
 * matching the convention that an earlier instant is the safer one for a
 * reminder. The caller is expected to surface the ambiguity in the
 * confirmation text rather than pretend the choice was unambiguous.
 */
export function resolveLocalToUtc(tz, y, mo, d, h, mi, s) {
  // Callers do plain integer arithmetic on calendar fields ("the 31st, plus one
  // month", "today, plus 40 days"), so month 13, day 32 and hour 24 all arrive
  // here legitimately. Normalize them first. This is not cosmetic: the
  // comparison at the bottom is against parts `Intl` produced, which are always
  // a real calendar date, so an un-normalized "Jan 32" would never match its own
  // "Feb 1" and an ordinary date would be misreported as a DST gap.
  const norm = normalizeWallClock(y, mo, d, h, mi, s);
  const target = utcFromParts(norm.year, norm.month, norm.day, norm.hour, norm.minute, norm.second);
  const before = tzOffsetMs(target - OFFSET_SAMPLE_MS, tz);
  const after = tzOffsetMs(target + OFFSET_SAMPLE_MS, tz);
  const candidates = [];
  const offsets = [before, after];
  for (let i = 0; i < offsets.length; i++) {
    const cand = target - offsets[i];
    if (candidates.indexOf(cand) === -1) candidates.push(cand);
  }
  const valid = candidates.filter(function (c) {
    return sameWallClock(zonedParts(c, tz), norm);
  });
  if (valid.length === 1) {
    return { kind: "exact", ms: valid[0], offsetMinutes: Math.round((target - valid[0]) / 60000) };
  }
  if (valid.length > 1) {
    valid.sort(function (a, b) { return a - b; });
    return { kind: "ambiguous", ms: valid[0], offsetMinutes: Math.round((target - valid[0]) / 60000), alternatives: valid };
  }
  // The wall clock fell into a DST gap. Report what it should become instead of
  // inventing a time: shifting by the pre-transition offset yields the instant
  // the platform itself would have produced.
  const shifted = target - before;
  const gap = Math.round((after - before) / 60000);
  return { kind: "nonexistent", suggestionMs: shifted, gapMinutes: Math.abs(gap) };
}

/**
 * Read an epoch out of a `resolveLocalToUtc` result.
 *
 * A wall clock inside a DST gap has no instant of its own, so the result carries
 * `suggestionMs` instead of `ms`. Every internal caller wants "the closest real
 * instant", so funnel them all through here rather than each one deciding.
 */
export function instantMs(resolved) {
  if (!resolved) return NaN;
  if (resolved.kind === "nonexistent") return resolved.suggestionMs;
  return resolved.ms;
}

/**
 * Add calendar days to a UTC instant, preserving the local wall clock.
 *
 * A daily reminder anchored at 02:30 in a zone that springs forward at 02:00
 * has no 02:30 that day. Rather than return `undefined`, the wall clock is
 * pushed forward by the gap (`suggestionMs`), which is what the platform itself
 * does — the reminder still fires that day, an hour later, instead of vanishing.
 */
export function addLocalDays(tz, ms, days) {
  const p = zonedParts(ms, tz);
  return instantMs(resolveLocalToUtc(tz, p.year, p.month, p.day + days, p.hour, p.minute, p.second));
}

/** Add calendar months, clamping the day to the target month's length. */
export function addLocalMonths(tz, ms, months) {
  const p = zonedParts(ms, tz);
  let total = (p.year * 12) + (p.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12 + 12) % 12 + 1;
  const maxDay = daysInGregorianMonth(year, month);
  const day = Math.min(p.day, maxDay);
  return instantMs(resolveLocalToUtc(tz, year, month, day, p.hour, p.minute, p.second));
}

/** Midnight (00:00:00) of the local day containing `ms`. */
export function startOfLocalDay(tz, ms) {
  const p = zonedParts(ms, tz);
  return instantMs(resolveLocalToUtc(tz, p.year, p.month, p.day, 0, 0, 0));
}

/** The local-day start for an explicit Gregorian date in `tz`. */
export function localDayStart(tz, y, mo, d, h, mi) {
  return instantMs(resolveLocalToUtc(tz, y, mo, d, h || 0, mi || 0, 0));
}

/**
 * Validate a `YYYY-MM-DD HH:MM` (or `YYYY/MM/DD`) string in a zone. Used by the
 * Mini App, where the browser sends a wall clock plus the zone name.
 */
export function parseWallClock(input) {
  if (!input || typeof input !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(input.trim());
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  const h = m[4] === undefined ? 0 : parseInt(m[4], 10);
  const mi = m[5] === undefined ? 0 : parseInt(m[5], 10);
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > daysInGregorianMonth(y, mo)) return null;
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return { year: y, month: mo, day: d, hour: h, minute: mi };
}

/** `+03:30` style offset label, for confirmations and diagnostics. */
export function offsetLabel(ms, tz) {
  const total = tzOffsetMinutes(ms, tz);
  const sign = total < 0 ? "-" : "+";
  const abs = Math.abs(total);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return sign + hh + ":" + mm;
}
