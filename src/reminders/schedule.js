// Recurrence arithmetic.
//
// A recurrence is stored as plain data so it survives every restart and cannot
// drift:
//
//   { bucket: "minute"|"hour"|"day"|"week"|"month"|"year",
//     interval: 1..365,          // "every 2 weeks"
//     weekday: 0..6 | null }     // "every Monday" — 0 = Sunday
//
// Occurrences are ALWAYS computed from the anchor (the first scheduled instant)
// multiplied out by the interval, never by repeatedly advancing the previous
// occurrence. That is what keeps a monthly reminder in place: iterating a
// Jan-31 reminder through February would clamp it to the 28th and then drag
// every later month to the 28th as well. Computing `anchor + 2 months` gives
// March 31 again, which is what a user means by "the 31st of every month".
import {
  addLocalDays, addLocalMonths, resolveLocalToUtc, utcFromParts, weekdayOf, zonedParts, instantMs
} from "./tz.js";

const MINUTE_MS = 60000;
const HOUR_MS = 3600000;

/** Buckets an interval may be applied to. */
export const RECURRENCE_BUCKETS = ["minute", "hour", "day", "week", "month", "year"];

const BUCKET_ALIASES = {
  minute: "minute", minutes: "minute", min: "minute", mins: "minute", "دقیقه": "minute", "دقیقه‌ای": "minute",
  hour: "hour", hours: "hour", hr: "hour", hrs: "hour", "ساعت": "hour",
  day: "day", days: "day", daily: "day", "روز": "day", "روزانه": "day",
  week: "week", weeks: "week", weekly: "week", "هفته": "week", "هفتگی": "week",
  month: "month", months: "month", monthly: "month", "ماه": "month", "ماهانه": "month", "ماهیانه": "month",
  year: "year", years: "year", yearly: "year", annually: "year", annual: "year", "سال": "year", "سالانه": "year", "سال‌یانه": "year"
};

/** Persian bucket labels for confirmations. */
const BUCKET_FA = { minute: "دقیقه", hour: "ساعت", day: "روز", week: "هفته", month: "ماه", year: "سال" };
const BUCKET_EN = { minute: "minute", hour: "hour", day: "day", week: "week", month: "month", year: "year" };

// Index follows `Date#getDay()` (0 = Sunday), which is what `weekdayOf` returns
// and what `normalizeRecurrence` stores. The Persian week starts on Saturday,
// but the storage convention must not follow presentation order.
const FA_WEEKDAY_NAMES = ["یک‌شنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه"];
const EN_WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const MAX_RECURRENCE_INTERVAL = 365;

/** Resolve a bucket alias to a canonical bucket name, or `null`. */
export function normalizeBucket(value) {
  if (!value) return null;
  const key = String(value).trim().toLowerCase();
  return BUCKET_ALIASES[key] || null;
}

/**
 * Validate and canonicalise a recurrence object.
 *
 * Returns `null` when the input describes no usable recurrence — callers treat
 * that as "one-shot reminder" rather than inventing a default interval.
 */
export function normalizeRecurrence(input) {
  if (!input) return null;
  const bucket = normalizeBucket(input.bucket);
  if (!bucket || RECURRENCE_BUCKETS.indexOf(bucket) === -1) return null;
  let interval = input.interval === undefined || input.interval === null ? 1 : parseInt(input.interval, 10);
  if (!Number.isFinite(interval) || interval < 1) interval = 1;
  if (interval > MAX_RECURRENCE_INTERVAL) interval = MAX_RECURRENCE_INTERVAL;
  let weekday = input.weekday === undefined || input.weekday === null ? null : parseInt(input.weekday, 10);
  if (!Number.isFinite(weekday) || weekday < 0 || weekday > 6) weekday = null;
  if (bucket !== "week") weekday = null;
  return { bucket: bucket, interval: interval, weekday: weekday };
}

/**
 * Advance an instant by `amount` buckets, preserving the local wall clock.
 *
 * `tz` is required: "a day later" is a calendar day in the user's zone, not 24
 * hours, so that a reminder set for 09:00 stays at 09:00 across a DST shift.
 */
export function advanceByBucket(ms, tz, bucket, amount) {
  const n = Math.trunc(amount);
  if (!n) return ms;
  switch (bucket) {
    case "minute": return ms + n * MINUTE_MS;
    case "hour": return ms + n * HOUR_MS;
    case "day": return addLocalDays(tz, ms, n);
    case "week": return addLocalDays(tz, ms, n * 7);
    case "month": return addLocalMonths(tz, ms, n);
    case "year": return addLocalMonths(tz, ms, n * 12);
    default: return addLocalDays(tz, ms, n);
  }
}

/** Interval length in milliseconds, for very short buckets. */
export function bucketMs(bucket, interval) {
  if (bucket === "minute") return interval * MINUTE_MS;
  if (bucket === "hour") return interval * HOUR_MS;
  return null;
}

/**
 * The occurrence after `currentIndex`, computed from the anchor.
 *
 * `index` is the number of occurrences already delivered: index 0 is the anchor
 * itself, so the next instant is `anchor + interval * (index + 1)`.
 */
export function occurrenceAt(anchorMs, tz, recurrence, index) {
  const rec = normalizeRecurrence(recurrence);
  if (!rec) return null;
  const step = rec.interval * (index + 1);
  return advanceByBucket(anchorMs, tz, rec.bucket, step);
}

/**
 * The first instant a recurrence should fire.
 *
 * Two shapes are supported:
 *   - `hour` / `minute` buckets: the wall clock the user typed is irrelevant
 *     ("every 30 minutes" has no time of day), so the series starts one interval
 *     after now.
 *   - everything else: the series starts at the next time the clock reads
 *     `hour:minute` in `tz`, skipping to the recurrence's weekday when it has
 *     one.
 */
export function firstRecurrenceStart(nowMs, tz, recurrence, hour, minute) {
  const rec = normalizeRecurrence(recurrence);
  if (!rec) return null;
  const short = bucketMs(rec.bucket, rec.interval);
  if (short !== null) return nowMs + short;

  const p = zonedParts(nowMs, tz);
  const h = Number.isFinite(hour) ? hour : p.hour;
  const mi = Number.isFinite(minute) ? minute : p.minute;
  let start = instantMs(resolveLocalToUtc(tz, p.year, p.month, p.day, h, mi, 0));
  if (start <= nowMs) start = addLocalDays(tz, start, 1);
  if (rec.weekday !== null) {
    for (let guard = 0; guard < 8 && zonedParts(start, tz).weekday !== rec.weekday; guard++) {
      start = addLocalDays(tz, start, 1);
    }
  }
  return start;
}

/** Human label for a recurrence, in the user's language. */
export function describeRecurrence(recurrence, lang) {
  const rec = normalizeRecurrence(recurrence);
  if (!rec) return "";
  const names = lang === "fa" ? BUCKET_FA : BUCKET_EN;
  const every = lang === "fa" ? "هر" : "every";
  const unit = names[rec.bucket];
  let text = rec.bucket === "day" && rec.interval === 1
    ? (lang === "fa" ? "هر روز" : "every day")
    : every + " " + (rec.interval === 1 ? "" : rec.interval + " ") + unit;
  if (rec.weekday !== null) {
    const wd = (lang === "fa" ? FA_WEEKDAY_NAMES : EN_WEEKDAY_NAMES)[rec.weekday];
    text = lang === "fa" ? ("هر " + wd) : ("every " + wd);
  }
  return text;
}

/** Weekday names, exported for the parser's confirmation text. */
export function weekdayName(weekday, lang) {
  const list = lang === "fa" ? FA_WEEKDAY_NAMES : EN_WEEKDAY_NAMES;
  return list[weekday] || "";
}

// Re-exported so the parser can build an anchor without reaching into tz.js.
export { resolveLocalToUtc, weekdayOf, utcFromParts, zonedParts };
