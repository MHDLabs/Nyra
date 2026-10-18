// Deterministic natural-language reminder parser (Persian + English).
//
// Design rules this file follows:
//
//   1. NO AI, NO NETWORK, NO AMBIENT CLOCK. The parser is a pure function of
//      (text, nowMs, timezone). A model is never required for an ordinary
//      reminder, and the parser can never be the reason a reminder is late.
//   2. NEVER INVENT A TIME. Every branch either produces a complete instant or
//      returns a `missing`/`error` code the caller turns into one concise
//      clarification question. `ok: true` means a real, future, in-range instant.
//   3. MATCH, THEN DELETE. Recognised spans are deleted from the title through
//      an index map back onto the ORIGINAL text, so the stored title is exactly
//      what the user wrote minus the scheduling words.
//   4. INVALID DATES ARE REJECTED, NOT ROLLED. "31 اسفند" in a 29-day Esfand, or
//      "31 February", is an error — never silently the 30th or 3 March.
//   5. AMBIGUITY IS REPORTED. A bare 1–12 hour is both 08:00 and 20:00; the
//      parser returns both readings and lets the user choose.
//
// Result shape:
//
//   {
//     ok,
//     at, atSeconds,        // resolved instant (ms / seconds); null when unresolved
//     tz, lang,
//     title, description, recurrence,
//     matched:   [{ type, text, value }],    // consumed spans, for confirmation
//     ambiguous: [{ kind, text, options }],  // user must choose
//     assumedDate, assumedTime,              // defaults applied, shown to the user
//     dstAmbiguous,                          // local time occurred twice (DST fall-back)
//     missing: "time"|"date"|"datetime"|"title"|"timezone"|null,
//     error:   "past"|"invalid_date"|"nonexistent_local_time"|"too_far"
//              |"unsupported_recurrence"|"missing_weekday_for_week"|null,
//     unsupported, suggestionMs, partial
//   }

import { MAX_REMINDER_TITLE, MAX_REMINDER_DESCRIPTION } from "../config.js";
import {
  normalizeForMatch, originalRange,
  PERSIAN_NUMBERS, ENGLISH_NUMBERS, PERSIAN_ORDINALS,
  JALALI_MONTH_LOOKUP, GREGORIAN_MONTH_LOOKUP, WEEKDAY_LOOKUP,
  DAY_WORDS, PERIOD_LOOKUP, DURATION_UNITS, STANDALONE_DURATIONS,
  RELATIVE_MARKERS, RECURRENCE_PHRASES, RECURRENCE_MARKERS, EVERY_OTHER_WORDS,
  REMINDER_CUES, TITLE_FILLERS, TITLE_TRAILERS
} from "./lexicon.js";
import {
  isValidTimeZone, resolveLocalToUtc, zonedParts, addLocalDays, instantMs
} from "./tz.js";
import {
  jalaliToGregorian, gregorianToJalali, isConvertibleJalaliYear, jalaliMonthLength
} from "./jalali.js";
import { normalizeRecurrence, normalizeBucket, firstRecurrenceStart } from "./schedule.js";

// A reminder more than ten years out is far more likely to be a parse error
// (a misread four-digit number) than a real intent.
const MAX_HORIZON_MS = 10 * 365 * 24 * 60 * 60 * 1000;

const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

/** Separator between an explicit title and description: "call mom | about the car". */
const DESCRIPTION_SEP_RE = /[|\u2014\u2013\n]/;

const BUCKET_WORDS = [
  "minutes", "minute", "mins", "min", "\u062F\u0642\u06CC\u0642\u0647",
  "hours", "hour", "hrs", "hr", "\u0633\u0627\u0639\u062A",
  "days", "day", "\u0631\u0648\u0632",
  "weeks", "week", "\u0647\u0641\u062A\u0647",
  "months", "month", "\u0645\u0627\u0647",
  "years", "year", "\u0633\u0627\u0644"
];

/** Words that introduce an explicit clock time, not a duration ("ساعت ۵" = 5:00). */
const TIME_INTRODUCERS = ["\u0633\u0627\u0639\u062A", "at", "around", "about", "@"];

const HOUR_UNIT_MS = DURATION_UNITS["\u0633\u0627\u0639\u062A"];

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Language and intent ---------------------------------------------------

/**
 * Detect the message language. Persian wins ties: Nyra's default response
 * language is Persian, and a Persian sentence containing English technical
 * terms is still a Persian sentence.
 */
export function detectLang(text) {
  const s = String(text || "");
  const fa = (s.match(/[\u0600-\u06FF]/g) || []).length;
  const en = (s.match(/[A-Za-z]/g) || []).length;
  if (fa === 0 && en === 0) return "fa";
  return fa >= en ? "fa" : "en";
}

/** Strip a leading slash command name before analysing the text. */
export function stripLeadingCommand(text) {
  return String(text || "").replace(/^\/[A-Za-z_]+(@\w+)?\s*/, "");
}

/**
 * True when the text contains a reminder cue phrase.
 *
 * Natural-language creation is gated on this so ordinary conversation is
 * unaffected: "فردا ساعت ۵ جلسه دارم" is chat, not a command, and must reach the
 * AI pipeline unchanged.
 */
export function looksLikeReminderRequest(text) {
  const norm = normalizeForMatch(stripLeadingCommand(text)).text;
  if (!norm) return false;
  for (let i = 0; i < REMINDER_CUES.length; i++) {
    if (phraseIndex(norm, normalizeForMatch(REMINDER_CUES[i]).text) !== -1) return true;
  }
  return false;
}

/**
 * Recurrence phrasing that is deliberately unsupported, so the user can be told
 * rather than silently given something different.
 */
export function detectUnsupportedRecurrence(text) {
  const norm = normalizeForMatch(text).text;
  if (!norm) return null;
  if (/(?:\u0647\u0631|every|each)\s*(?:\u062F\u0648|\u0633\u0647|\u0686\u0647\u0627\u0631)\s*\u0645\u06CC\u0646/.test(norm)) return "ordinal_weekday";
  if (/(?:\u0627\u0648\u0644|\u0622\u062E\u0631)(?:\u06CC\u0646)?\s*\u0647\u0631\s*(?:\u0645\u0627\u0647|\u0647\u0641\u062A\u0647)/.test(norm)) return "first_or_last_of_period";
  if (/(?:first|last)\s+(?:day\s+)?of\s+(?:every|each)\s+month/.test(norm)) return "first_or_last_of_period";
  // "the first monday of each month" needs an nth-weekday rule the recurrence
  // model does not have, so it must be refused rather than degraded into a
  // plain monthly reminder that silently fires on the wrong day.
  if (/(?:first|second|third|fourth|fifth|last|\u0627\u0648\u0644\u06CC\u0646|\u0622\u062E\u0631\u06CC\u0646)\s+(?:\S+\s+)?(?:of\s+)?(?:every|each|the)\s+(?:month|week|\u0645\u0627\u0647|\u0647\u0641\u062A\u0647)/.test(norm)) return "first_or_last_of_period";
  if (/\u062A\u0639\u0637\u06CC\u0644\u0627\u062A|holiday|business day|\u0631\u0648\u0632 \u06A9\u0627\u0631\u06CC|\u0642\u0645\u0631\u06CC|lunar/.test(norm)) return "calendar_system";
  if (/(?:\u0647\u0631|every)\s*(?:\d+\s*)?(?:\u0631\u0648\u0632|day)s?\s*(?:\u0632\u0648\u062C|\u0641\u0631\u062F|even|odd)/.test(norm)) return "day_parity";
  return null;
}

// --- Cursor ----------------------------------------------------------------

function createCursor(text) {
  const src = String(text || "");
  const norm = normalizeForMatch(src);
  return { original: src, norm: norm.text, map: norm.map, used: new Array(norm.text.length).fill(false) };
}

/** Mark a normalised-space span as consumed so later passes cannot re-match it. */
function consume(cursor, start, end) {
  for (let i = start; i < end && i < cursor.used.length; i++) cursor.used[i] = true;
}

function isFree(cursor, start, end) {
  for (let i = start; i < end; i++) if (cursor.used[i]) return false;
  return true;
}

/** True when two spans are separated by at most `maxGap` characters. */
function spanGap(a, b, maxGap) {
  return Math.max(0, Math.max(a.start, b.start) - Math.min(a.end, b.end)) <= maxGap;
}

/**
 * Word-boundary-aware phrase search in a plain string.
 *
 * `ignoreBefore` / `ignoreAfter` drop the boundary test on one side, which the
 * duration matcher needs: in "5h" the "5" is a word character but must still
 * count as a boundary.
 */
function phraseIndex(haystack, phrase, opts) {
  if (!phrase) return -1;
  const o = opts || {};
  const startsWord = WORD_CHAR_RE.test(phrase[0]);
  const endsWord = WORD_CHAR_RE.test(phrase[phrase.length - 1]);
  let from = 0;
  while (from <= haystack.length - phrase.length) {
    const idx = haystack.indexOf(phrase, from);
    if (idx === -1) return -1;
    const end = idx + phrase.length;
    const before = idx > 0 ? haystack[idx - 1] : "";
    const after = end < haystack.length ? haystack[end] : "";
    const badBefore = startsWord && !o.ignoreBefore && before && WORD_CHAR_RE.test(before);
    const badAfter = endsWord && !o.ignoreAfter && after && WORD_CHAR_RE.test(after);
    if (!badBefore && !badAfter) return idx;
    from = idx + 1;
  }
  return -1;
}

/** Unconsumed phrase hit as `{ start, end, len }`, or `null`. */
function findPhrase(cursor, phrase, opts) {
  const p = normalizeForMatch(phrase).text;
  if (!p) return null;
  const o = opts || {};
  const startsWord = WORD_CHAR_RE.test(p[0]);
  const endsWord = WORD_CHAR_RE.test(p[p.length - 1]);
  let from = 0;
  while (from <= cursor.norm.length - p.length) {
    const idx = cursor.norm.indexOf(p, from);
    if (idx === -1) return null;
    const end = idx + p.length;
    const before = idx > 0 ? cursor.norm[idx - 1] : "";
    const after = end < cursor.norm.length ? cursor.norm[end] : "";
    const badBefore = startsWord && !o.ignoreBefore && before && WORD_CHAR_RE.test(before);
    const badAfter = endsWord && !o.ignoreAfter && after && WORD_CHAR_RE.test(after);
    if (!badBefore && !badAfter && isFree(cursor, idx, end)) return { start: idx, end: end, len: p.length };
    from = idx + 1;
  }
  return null;
}

/** Longest unconsumed match across a `{ phrase, value }` table. */
function findLongest(cursor, table) {
  let best = null;
  for (let i = 0; i < table.length; i++) {
    const hit = findPhrase(cursor, table[i].phrase);
    if (!hit) continue;
    if (!best || hit.len > best.len) {
      best = { start: hit.start, end: hit.end, len: hit.len, value: table[i].value };
    }
  }
  return best;
}

/** Unconsumed number immediately before `index`: digits first, then number word. */
function readNumberBefore(cursor, index) {
  const head = cursor.norm.slice(0, index).replace(/\s+$/, "");
  const m = /(\d+)$/.exec(head);
  if (m) {
    const end = head.length;
    const start = end - m[1].length;
    if (start > 0 && /\d/.test(cursor.norm[start - 1])) return null;
    if (!isFree(cursor, start, end)) return null;
    return { start: start, end: end, value: parseInt(m[1], 10) };
  }
  return readNumberWordBefore(cursor, head);
}

/** Persian or English number word immediately at the end of `head`. */
function readNumberWordBefore(cursor, head) {
  let best = null;
  const tables = [PERSIAN_NUMBERS, ENGLISH_NUMBERS];
  for (let t = 0; t < tables.length; t++) {
    const keys = Object.keys(tables[t]);
    for (let k = 0; k < keys.length; k++) {
      const word = keys[k];
      if (!word || head.length < word.length) continue;
      if (head.slice(-word.length) !== word) continue;
      const start = head.length - word.length;
      if (start > 0 && WORD_CHAR_RE.test(head[start - 1])) continue;
      if (!isFree(cursor, start, head.length)) continue;
      if (!best || word.length > best.len) {
        best = { start: start, end: head.length, value: tables[t][word], len: word.length };
      }
    }
  }
  return best ? { start: best.start, end: best.end, value: best.value } : null;
}

/** A number word that makes up a whole string, e.g. "دو" in "هر دو هفته". */
function readNumberWordExact(text) {
  if (!text) return null;
  if (PERSIAN_NUMBERS[text] !== undefined) return PERSIAN_NUMBERS[text];
  if (ENGLISH_NUMBERS[text] !== undefined) return ENGLISH_NUMBERS[text];
  return null;
}

/** Unconsumed digits immediately after `index`. */
function readNumberAfter(cursor, index) {
  const m = /^(\s*)(\d+)/.exec(cursor.norm.slice(index));
  if (!m) return null;
  const start = index + m[1].length;
  const end = start + m[2].length;
  if (!isFree(cursor, start, end)) return null;
  return { start: start, end: end, value: parseInt(m[2], 10), text: m[2] };
}

// --- Time ------------------------------------------------------------------

/** 24-hour value for a 12-hour number under a meridiem hint, or `null`. */
function resolveHour(number, meridiem) {
  const n = Number(number);
  if (!Number.isFinite(n)) return null;
  if (meridiem === "am") return n === 12 ? 0 : (n >= 1 && n <= 11 ? n : null);
  if (meridiem === "pm") return n === 12 ? 12 : (n >= 1 && n <= 11 ? n + 12 : null);
  if (meridiem === "midnight") return (n === 12 || n === 0) ? 0 : null;
  return (n >= 0 && n <= 23) ? n : null;
}

/** am/pm immediately before or after a matched hour. */
function meridiemNear(norm, start, end) {
  const after = norm.slice(end, end + 6);
  const before = norm.slice(Math.max(0, start - 6), start);
  if (/^\s*(am|a\.m)\b/.test(after)) return "am";
  if (/^\s*(pm|p\.m)\b/.test(after)) return "pm";
  if (/\b(am|a\.m)\s*$/.test(before)) return "am";
  if (/\b(pm|p\.m)\s*$/.test(before)) return "pm";
  return null;
}

/** Both readings of an undecidable 12-hour value, for the clarification ask. */
function meridiemAmbiguity(hour, text, cursor, normStart, normEnd) {
  const h12 = resolveHour(hour, "pm");
  const label = function (h) { return (h < 10 ? "0" + h : String(h)) + ":00"; };
  const morning = resolveHour(hour, "am");
  // `range` is an original-text span. The clarification flow rewrites just this
  // span with the chosen hour, so the user's own wording for the rest of the
  // request survives untouched.
  return {
    kind: "meridiem",
    text: text || "",
    range: (cursor && Number.isInteger(normStart) && Number.isInteger(normEnd))
      ? originalRange(cursor.map, normStart, normEnd) : null,
    minute: 0,
    options: [
      { hour: morning, minute: 0, label: label(morning) },
      { hour: h12, minute: 0, label: label(h12) }
    ]
  };
}

/** Apply an optional meridiem and decide whether the hour is genuinely ambiguous. */
function buildTime(cursor, hour, minute, start, end, meridiem, text, force24) {
  if (meridiem) {
    const resolved = resolveHour(hour, meridiem);
    if (resolved === null) return null;
    return {
      hour: resolved, minute: minute, start: start, end: extendOverMeridiem(cursor.norm, end, meridiem),
      ambiguous: false, todayOnly: false, text: text
    };
  }
  // A bare 1–12 is both morning and evening. Report it instead of guessing.
  // `force24` is set for zero-padded colon times ("02:30") and for hours above
  // 12, where the 24-hour reading is the only sensible one.
  const ambiguous = !force24 && hour >= 1 && hour <= 12 && minute === 0;
  const ambiguousAny = !force24 && hour >= 1 && hour <= 12;
  return {
    hour: hour, minute: minute, start: start, end: end,
    ambiguous: minute === 0 ? ambiguous : ambiguousAny, todayOnly: false, text: text
  };
}

/**
 * Widen a matched clock span over its trailing "am"/"pm" token.
 *
 * The meridiem is detected at match time but sits just outside the numeric span,
 * so without this it would survive into the generated title.
 */
function extendOverMeridiem(norm, end, meridiem) {
  if (meridiem !== "am" && meridiem !== "pm") return end;
  const m = /^\s*(a\.?m|p\.?m)(?!\w)/.exec(norm.slice(end, end + 6));
  return m ? end + m[0].length : end;
}

/**
 * Explicit clock time: `14:30`, `۸٫۳۰`, `2.30pm`, `ساعت 8`, `at 9`,
 * `half past three`, `quarter to 5`.
 *
 * The colon/dot separator set deliberately excludes `/` and `-`, so a numeric
 * date can never be read as a clock time; numeric dates are matched and
 * consumed before this function runs.
 */
function matchClockTime(cursor) {
  const norm = cursor.norm;

  const colonRe = /(\d{1,2})\s*[:.\u066B\u066C]\s*(\d{2})(?!\d)/g;
  let m;
  while ((m = colonRe.exec(norm)) !== null) {
    let start = m.index;
    const end = start + m[0].length;
    if (start > 0 && /\d/.test(norm[start - 1])) continue;
    if (!isFree(cursor, start, end)) continue;
    const hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    if (hour > 23 || minute > 59) continue;
    const intro = findIntroducerBefore(cursor, start);
    if (intro !== null) start = intro;
    const force24 = hour > 12 || (m[1].length === 2 && m[1][0] === "0");
    return buildTime(cursor, hour, minute, start, end, meridiemNear(norm, start, end), norm.slice(start, end), force24);
  }

  const offsets = [
    { re: /half past\s+(\d{1,2})/, minute: 30, delta: 0 },
    { re: /quarter past\s+(\d{1,2})/, minute: 15, delta: 0 },
    { re: /quarter to\s+(\d{1,2})/, minute: 45, delta: -1 },
    { re: /twenty to\s+(\d{1,2})/, minute: 40, delta: -1 },
    { re: /ten to\s+(\d{1,2})/, minute: 50, delta: -1 }
  ];
  for (let i = 0; i < offsets.length; i++) {
    const hit = offsets[i].re.exec(norm);
    if (!hit) continue;
    let start = hit.index;
    const end = start + hit[0].length;
    if (!isFree(cursor, start, end)) continue;
    let hour = parseInt(hit[1], 10) + offsets[i].delta;
    if (hour < 0) hour += 24;
    if (hour > 23) continue;
    const intro = findIntroducerBefore(cursor, start);
    if (intro !== null) start = intro;
    return buildTime(cursor, hour, offsets[i].minute, start, end, meridiemNear(norm, start, end), norm.slice(start, end), hour > 12);
  }

  for (let i = 0; i < TIME_INTRODUCERS.length; i++) {
    const hit = findPhrase(cursor, TIME_INTRODUCERS[i]);
    if (!hit) continue;
    const after = readNumberAfter(cursor, hit.end);
    if (!after || after.value > 23) continue;
    const meridiem = meridiemNear(norm, hit.start, after.end);
    const force24 = after.value > 12 || (after.text.length === 2 && after.text[0] === "0");
    return buildTime(cursor, after.value, 0, hit.start, after.end, meridiem, norm.slice(hit.start, after.end), force24);
  }
  return null;
}

/** "ساعت" / "at" immediately before a number, folded into the matched span. */
function findIntroducerBefore(cursor, index) {
  // Trailing whitespace in `head` would offset the computed start, so the tail
  // is trimmed and the phrase must be the literal suffix of the trimmed text.
  const head = cursor.norm.slice(0, index).replace(/\s+$/, "");
  for (let i = 0; i < TIME_INTRODUCERS.length; i++) {
    const phrase = normalizeForMatch(TIME_INTRODUCERS[i]).text;
    if (!phrase || head.length < phrase.length) continue;
    if (head.slice(-phrase.length) !== phrase) continue;
    let start = head.length - phrase.length;
    if (start > 0 && WORD_CHAR_RE.test(head[start - 1])) continue;
    // "سر ساعت ۳" / "sharp at 3": the intensifier belongs to the same span.
    const sharp = /(?:\u0633\u0631|sharp)\s*$/.exec(head.slice(0, start));
    if (sharp && (sharp.index === 0 || !WORD_CHAR_RE.test(head[sharp.index - 1]))) {
      start = sharp.index;
    }
    if (!isFree(cursor, start, index)) continue;
    return start;
  }
  return null;
}

/**
 * A period word bound to an hour ("۸ شب" -> 20:00, "at 6 in the morning") or
 * standing alone with its own default hour ("فردا صبح" -> 09:00).
 *
 * `explicitHour` is false when the period word supplied the hour itself, which
 * lets the caller prefer an explicit clock reading over the default.
 */
function matchPeriod(cursor) {
  for (let i = 0; i < PERIOD_LOOKUP.length; i++) {
    const entry = PERIOD_LOOKUP[i];
    if (entry.requiresIn) continue;
    const hit = findPhrase(cursor, entry.phrase);
    if (!hit) continue;
    const number = readNumberBefore(cursor, hit.start);
    if (number) {
      if (entry.meridiem === "midnight" && number.value !== 12 && number.value !== 0) continue;
      if (entry.meridiem && !entry.meridiem.startsWith("mid") && (number.value < 1 || number.value > 12)) continue;
      const hour = entry.meridiem ? resolveHour(number.value, entry.meridiem) : number.value;
      if (hour === null) continue;
      let start = number.start;
      const introducer = findIntroducerBefore(cursor, number.start);
      if (introducer !== null) start = introducer;
      return {
        hour: hour, minute: 0, start: start, end: hit.end, ambiguous: false,
        explicitHour: true, meridiem: entry.meridiem || null,
        todayOnly: !!entry.todayOnly, text: cursor.norm.slice(start, hit.end)
      };
    }
    return {
      hour: entry.defaultHour, minute: 0, start: hit.start, end: hit.end, ambiguous: false,
      explicitHour: false, meridiem: entry.meridiem || null,
      todayOnly: !!entry.todayOnly, approx: entry.approx || null,
      text: cursor.norm.slice(hit.start, hit.end)
    };
  }
  return null;
}

/**
 * Pick the best clock reading, merging a period word with an explicit clock
 * when they sit next to each other: "ساعت ۸ شب" and "شب ساعت ۸" both mean 20:00,
 * and the period resolves the otherwise ambiguous bare hour.
 */
function resolveClock(cursor) {
  const period = matchPeriod(cursor);
  const plain = matchClockTime(cursor);
  if (period && plain && spanGap(period, plain, 2)) {
    const start = Math.min(period.start, plain.start);
    const end = Math.max(period.end, plain.end);
    const text = cursor.norm.slice(start, end);
    if (plain.ambiguous && period.meridiem) {
      const hour = resolveHour(plain.hour, period.meridiem);
      if (hour !== null) {
        return {
          hour: hour, minute: plain.minute, start: start, end: end, ambiguous: false,
          todayOnly: plain.todayOnly || period.todayOnly, text: text
        };
      }
    }
    return {
      hour: plain.hour, minute: plain.minute, start: start, end: end,
      ambiguous: plain.ambiguous, todayOnly: plain.todayOnly || period.todayOnly, text: text
    };
  }
  if (period && period.explicitHour) return period;
  if (plain) return plain;
  return period;
}

// --- Date ------------------------------------------------------------------

/** Recognise a month name in either calendar; longest match wins. */
function matchMonthName(cursor) {
  const j = findLongest(cursor, JALALI_MONTH_LOOKUP.map(function (e) {
    return { phrase: e.phrase, value: { calendar: "jalali", month: e.value } };
  }));
  const g = findLongest(cursor, GREGORIAN_MONTH_LOOKUP.map(function (e) {
    return { phrase: e.phrase, value: { calendar: "gregorian", month: e.value } };
  }));
  const only = (j && g) ? (j.len >= g.len ? j : g) : (j || g);
  if (!only) return null;
  return { start: only.start, end: only.end, len: only.len, calendar: only.value.calendar, month: only.value.month };
}

/** Persian ordinal immediately before a month name ("پنجم مرداد"). */
function readOrdinalBefore(cursor, index) {
  const table = Object.keys(PERSIAN_ORDINALS)
    .map(function (k) { return { phrase: k, value: PERSIAN_ORDINALS[k] }; })
    .sort(function (a, b) { return b.phrase.length - a.phrase.length; });
  let best = null;
  for (let i = 0; i < table.length; i++) {
    const hit = findPhrase(cursor, table[i].phrase);
    if (!hit || hit.end > index) continue;
    if (cursor.norm.slice(hit.end, index).trim().length > 0) continue;
    if (!best || hit.end > best.end) best = { start: hit.start, end: hit.end, value: table[i].value };
  }
  return best;
}

/** A four-digit year adjacent to a date expression, or `null`. */
function readYearNear(cursor, from, to) {
  const tail = /^(\s*)(\d{4})(?!\d)/.exec(cursor.norm.slice(to, to + 8));
  if (tail) {
    const start = to + tail[1].length;
    const end = start + 4;
    const y = parseInt(tail[2], 10);
    if (isFree(cursor, start, end)) return { value: y, start: start, end: end };
  }
  const headStart = Math.max(0, from - 8);
  const head = /(\d{4})(?!\d)(\s*)$/.exec(cursor.norm.slice(headStart, from));
  if (head) {
    const start = headStart + head.index;
    const end = start + 4;
    const y = parseInt(head[1], 10);
    if (isFree(cursor, start, end)) return { value: y, start: start, end: end };
  }
  return null;
}

function isValidGregorian(y, mo, d) {
  if (!Number.isInteger(y) || !Number.isInteger(d) || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

const GREGORIAN_MONTH_MAX = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Reject a named date that does not exist instead of rolling it into the next
 * month. The widest plausible month length is used when no year was given, so
 * "29 فوریه" stays valid (a leap day exists in some year) while "30 فوریه" and
 * "31 اسفند" in a 29-day Esfand are refused.
 */
function isValidNamedDate(spec, refJalaliYear) {
  if (!Number.isInteger(spec.day) || spec.day < 1) return false;
  if (spec.calendar === "jalali") {
    if (!Number.isInteger(spec.month) || spec.month < 1 || spec.month > 12) return false;
    if (spec.year !== null) return spec.day <= jalaliMonthLength(spec.year, spec.month);
    // Month 12 is 29 or 30 days depending on the leap year, so 30 is permitted.
    return spec.day <= (spec.month <= 6 ? 31 : 30);
  }
  if (!Number.isInteger(spec.month) || spec.month < 1 || spec.month > 12) return false;
  if (spec.year !== null) return isValidGregorian(spec.year, spec.month, spec.day);
  return spec.day <= GREGORIAN_MONTH_MAX[spec.month - 1];
}

/** Explicit date with a named month: "۵ مرداد", "may 3", "31 dec 2026". */
function matchNamedDate(cursor) {
  const month = matchMonthName(cursor);
  if (!month) return null;

  let day = null;
  const before = readNumberBefore(cursor, month.start);
  if (before) day = { start: before.start, end: before.end, value: before.value };
  if (!day) {
    const after = readNumberAfter(cursor, month.end);
    if (after) day = { start: after.start, end: after.end, value: after.value };
  }
  if (!day) {
    const ord = readOrdinalBefore(cursor, month.start);
    if (ord) day = { start: ord.start, end: ord.end, value: ord.value };
  }
  if (!day) return null;

  const from = Math.min(month.start, day.start);
  const to = Math.max(month.end, day.end);
  const yearHit = readYearNear(cursor, from, to);
  if (month.calendar === "jalali" && yearHit && !isConvertibleJalaliYear(yearHit.value)) return null;

  const spans = [{ start: month.start, end: month.end }, { start: day.start, end: day.end }];
  if (yearHit) spans.push({ start: yearHit.start, end: yearHit.end });
  return {
    calendar: month.calendar, month: month.month, day: day.value,
    year: yearHit ? yearHit.value : null, spans: spans
  };
}

/** Leftmost / rightmost edge of a span list, since day may precede the month. */
function spanBounds(spans) {
  let start = spans[0].start;
  let end = spans[0].end;
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < start) start = spans[i].start;
    if (spans[i].end > end) end = spans[i].end;
  }
  return { start: start, end: end };
}

/**
 * Numeric date with an explicit four-digit year: `1404/5/12` (year first) or
 * `12/5/1404`.
 *
 * Two-part dates like `5/12` are deliberately NOT accepted — genuinely
 * ambiguous between 5 Mordad and 5 December, so the parser asks instead.
 */
function matchNumericDate(cursor) {
  const yearFirst = /(\d{4})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?!\d)/g;
  const yearLast = /(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{4})(?!\d)/g;
  let m;

  while ((m = yearFirst.exec(cursor.norm)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (start > 0 && /\d/.test(cursor.norm[start - 1])) continue;
    if (!isFree(cursor, start, end)) continue;
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    if (month < 1 || month > 12) continue;
    const calendar = year < 1700 ? "jalali" : "gregorian";
    if (calendar === "jalali" && !isConvertibleJalaliYear(year)) continue;
    if (calendar === "gregorian" && (year < 1900 || year > 2400)) continue;
    return { calendar: calendar, year: year, month: month, day: day, spans: [{ start: start, end: end }] };
  }

  while ((m = yearLast.exec(cursor.norm)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (start > 0 && /\d/.test(cursor.norm[start - 1])) continue;
    if (!isFree(cursor, start, end)) continue;
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    let month, day;
    if (a > 12 && b <= 12) { day = a; month = b; }
    else if (b > 12 && a <= 12) { month = a; day = b; }
    else continue; // undecidable ordering — refuse rather than guess
    const calendar = year < 1700 ? "jalali" : "gregorian";
    if (calendar === "jalali" && !isConvertibleJalaliYear(year)) continue;
    if (calendar === "gregorian" && (year < 1900 || year > 2400)) continue;
    return { calendar: calendar, year: year, month: month, day: day, spans: [{ start: start, end: end }] };
  }
  return null;
}

/** Relative day expressions: today / tomorrow / day after tomorrow / week words. */
function matchDayWord(cursor) {
  const day = findLongest(cursor, DAY_WORDS.map(function (e) { return { phrase: e.phrase, value: e.value }; }));
  const week = findLongest(cursor, [
    { phrase: "\u0647\u0641\u062A\u0647 \u0628\u0639\u062F", value: "next_week" },
    { phrase: "\u0647\u0641\u062A\u0647 \u0622\u06CC\u0646\u062F\u0647", value: "next_week" },
    { phrase: "next week", value: "next_week" },
    { phrase: "\u0627\u06CC\u0646 \u0647\u0641\u062A\u0647", value: "this_week" },
    { phrase: "this week", value: "this_week" },
    { phrase: "\u0622\u062E\u0631 \u0647\u0641\u062A\u0647", value: "weekend" },
    { phrase: "weekend", value: "weekend" }
  ]);
  if (day && week) return day.len >= week.len ? day : week;
  return day || week;
}

/** Weekday name. Short English forms need a relative marker to be accepted. */
function matchWeekday(cursor) {
  let best = null;
  for (let i = 0; i < WEEKDAY_LOOKUP.length; i++) {
    const entry = WEEKDAY_LOOKUP[i];
    const hit = findPhrase(cursor, entry.phrase);
    if (!hit) continue;
    if (entry.short) {
      const head = cursor.norm.slice(Math.max(0, hit.start - 10), hit.start);
      const tail = cursor.norm.slice(hit.end, hit.end + 8);
      const legit = /(next|this|on|coming|every|\u062A\u0627|\u0627\u06CC\u0646)\s+$/.test(head) ||
        /^\s*(at|$)/.test(tail);
      if (!legit) continue;
    }
    if (!best || hit.len > best.len) best = { start: hit.start, end: hit.end, len: hit.len, value: entry.value };
  }
  return best;
}

// --- Duration --------------------------------------------------------------

let durationTableCache = null;

function durationUnitsTable() {
  if (durationTableCache) return durationTableCache;
  durationTableCache = Object.keys(DURATION_UNITS)
    .sort(function (a, b) { return b.length - a.length; })
    .map(function (k) { return { phrase: k, value: DURATION_UNITS[k] }; });
  return durationTableCache;
}

/** "و نیم" / " and a half" immediately after a duration unit. */
function findFractionAfter(cursor, index) {
  const options = [
    { phrase: "\u0648 \u0646\u06CC\u0645", value: 0.5 },
    { phrase: "\u0648 \u0631\u0628\u0639", value: 0.25 },
    { phrase: "and a half", value: 0.5 },
    { phrase: "and half", value: 0.5 }
  ];
  for (let i = 0; i < options.length; i++) {
    const hit = findPhrase(cursor, options[i].phrase);
    if (!hit || hit.start !== index) continue;
    return { start: hit.start, end: hit.end, value: options[i].value };
  }
  return null;
}

/** True when a relative marker sits immediately adjacent to `[start, end)`. */
function hasRelativeMarker(cursor, start, end) {
  for (let i = 0; i < RELATIVE_MARKERS.length; i++) {
    const hit = findPhrase(cursor, RELATIVE_MARKERS[i].phrase);
    if (!hit) continue;
    if (hit.end <= start && cursor.norm.slice(hit.end, start).trim().length === 0) return true;
    if (hit.start >= end && cursor.norm.slice(end, hit.start).trim().length === 0) return true;
  }
  return false;
}

/** Consume a relative marker immediately adjacent to a duration span. */
function consumeAdjacentMarker(cursor, start, end) {
  for (let i = 0; i < RELATIVE_MARKERS.length; i++) {
    const hit = findPhrase(cursor, RELATIVE_MARKERS[i].phrase);
    if (!hit) continue;
    const before = hit.end <= start && cursor.norm.slice(hit.end, start).trim().length === 0;
    const after = hit.start >= end && cursor.norm.slice(end, hit.start).trim().length === 0;
    if (before || after) consume(cursor, hit.start, hit.end);
  }
}

/**
 * Relative duration: "in 2 hours", "۲ ساعت دیگه", "half an hour", "۳۰ دقیقه بعد".
 *
 * An hour-unit duration REQUIRES an adjacent relative marker, because "۲ ساعت"
 * and "ساعت ۲" are different statements ("2 hours" vs "2 o'clock") and only the
 * marker settles which one was meant.
 */
function matchDuration(cursor) {
  let standalone = null;
  for (let i = 0; i < STANDALONE_DURATIONS.length; i++) {
    const hit = findPhrase(cursor, STANDALONE_DURATIONS[i].phrase);
    if (!hit) continue;
    if (!standalone || hit.len > standalone.len) {
      standalone = { start: hit.start, end: hit.end, len: hit.len, ms: STANDALONE_DURATIONS[i].ms };
    }
  }

  const table = durationUnitsTable();
  for (let i = 0; i < table.length; i++) {
    const unit = table[i];
    const normUnit = normalizeForMatch(unit.phrase).text;
    const singleLetter = normUnit.length === 1;
    const hit = singleLetter
      ? findPhrase(cursor, unit.phrase, { ignoreBefore: true, ignoreAfter: true })
      : findPhrase(cursor, unit.phrase, { ignoreBefore: true });
    if (!hit) continue;
    if (singleLetter && !/\d/.test(cursor.norm[hit.start - 1] || "")) continue;
    const number = readNumberBefore(cursor, hit.start);
    if (!number) continue;
    if (unit.value === HOUR_UNIT_MS) {
      // "ساعت ۲" is a clock time, never "2 hours".
      const head = cursor.norm.slice(0, number.start);
      if (/(\u0633\u0627\u0639\u062A|\bat|\babout|\baround)\s*$/.test(head)) continue;
      if (!hasRelativeMarker(cursor, number.start, hit.end)) continue;
    }
    let ms = number.value * unit.value;
    let end = hit.end;
    const frac = findFractionAfter(cursor, hit.end);
    if (frac && ms >= unit.value) { ms += frac.value * unit.value; end = frac.end; }
    if (ms > 0) return { ms: ms, start: number.start, end: end };
  }
  if (standalone) return { ms: standalone.ms, start: standalone.start, end: standalone.end };
  return null;
}

// --- Recurrence ------------------------------------------------------------

/**
 * Recurrence detection.
 *
 * Pass 1 matches the fixed phrase table ("هر روز", "weekly", …).
 * Pass 2 handles the productive form: a marker ("هر", "every") followed by an
 * optional interval and a bucket word, or by a weekday name.
 */
function matchRecurrence(cursor) {
  const phrases = RECURRENCE_PHRASES.map(function (e) {
    return { phrase: e.phrase, value: { bucket: e.bucket, interval: e.interval, hour: e.hour } };
  });
  const direct = findLongest(cursor, phrases);
  if (direct) {
    const rec = normalizeRecurrence({ bucket: direct.value.bucket, interval: direct.value.interval });
    if (rec) {
      return {
        start: direct.start, end: direct.end, recurrence: rec,
        impliedHour: direct.value.hour === undefined ? null : direct.value.hour
      };
    }
  }

  // "any" is deliberately excluded: "any day now" is not a recurrence, and the
  // phrase table above already covers every real recurring form.
  const markers = RECURRENCE_MARKERS
    .filter(function (p) { return normalizeForMatch(p).text !== "any"; })
    .map(function (p) { return { phrase: p, value: p }; });
  const marker = findLongest(cursor, markers);
  if (!marker) return null;
  const tail = cursor.norm.slice(marker.end);

  let interval = 1;
  for (let i = 0; i < EVERY_OTHER_WORDS.length; i++) {
    const word = normalizeForMatch(EVERY_OTHER_WORDS[i]).text.trim();
    if (!word) continue;
    if (new RegExp("^\\s*" + escapeRe(word) + "(?!\\S)").test(tail)) { interval = 2; break; }
  }

  let bucketHit = null;
  for (let i = 0; i < BUCKET_WORDS.length; i++) {
    const idx = phraseIndex(tail, BUCKET_WORDS[i]);
    if (idx === -1) continue;
    const bucket = normalizeBucket(BUCKET_WORDS[i]);
    if (!bucket) continue;
    if (!bucketHit || idx < bucketHit.index) {
      bucketHit = { index: idx, len: BUCKET_WORDS[i].length, bucket: bucket };
    }
  }

  if (bucketHit) {
    const absStart = marker.end + bucketHit.index;
    const absEnd = absStart + bucketHit.len;
    if (!isFree(cursor, absStart, absEnd)) return null;
    const explicit = /(\d+)/.exec(cursor.norm.slice(marker.end, absStart));
    if (explicit) interval = parseInt(explicit[1], 10);
    else {
      // "هر دو هفته" — the interval is a Persian number word, not digits.
      const word = readNumberWordExact(cursor.norm.slice(marker.end, absStart).trim());
      if (word !== null) interval = word;
    }
    if (bucketHit.bucket === "week") {
      const wd = matchWeekday(cursor);
      if (wd) {
        return {
          start: marker.start, end: Math.max(absEnd, wd.end),
          recurrence: normalizeRecurrence({ bucket: "week", interval: interval, weekday: wd.value }),
          impliedHour: null
        };
      }
    }
    return {
      start: marker.start, end: absEnd,
      recurrence: normalizeRecurrence({ bucket: bucketHit.bucket, interval: interval }),
      impliedHour: null
    };
  }

  const wd = matchWeekday(cursor);
  if (wd && wd.start >= marker.end) {
    return {
      start: marker.start, end: wd.end,
      recurrence: normalizeRecurrence({ bucket: "week", interval: interval, weekday: wd.value }),
      impliedHour: null
    };
  }
  return null;
}

// --- Title -----------------------------------------------------------------

/** Consumed normalised spans merged into original-text ranges. */
function consumedRanges(cursor) {
  const ranges = [];
  let i = 0;
  while (i < cursor.norm.length) {
    if (!cursor.used[i]) { i++; continue; }
    let j = i;
    while (j < cursor.norm.length && cursor.used[j]) j++;
    const r = originalRange(cursor.map, i, j);
    if (r) ranges.push(r);
    i = j;
  }
  return ranges;
}

/** `original[from, to)` with every range in `ranges` removed. */
function stripRanges(original, ranges, from, to) {
  const cuts = [];
  for (let i = 0; i < ranges.length; i++) {
    const a = Math.max(ranges[i].start, from);
    const b = Math.min(ranges[i].end, to);
    if (b > a) cuts.push([a, b]);
  }
  cuts.sort(function (x, y) { return x[0] - y[0]; });
  let out = "";
  let at = from;
  for (let i = 0; i < cuts.length; i++) {
    if (cuts[i][0] > at) out += original.slice(at, cuts[i][0]);
    at = Math.max(at, cuts[i][1]);
  }
  if (at < to) out += original.slice(at, to);
  return out;
}

let fillerCache = null;

function fillerWords() {
  if (fillerCache) return fillerCache;
  const norm = function (list) {
    return list.map(function (p) { return normalizeForMatch(p).text; })
      .filter(Boolean)
      .sort(function (a, b) { return b.length - a.length; });
  };
  fillerCache = { fillers: norm(TITLE_FILLERS), trailers: norm(TITLE_TRAILERS) };
  return fillerCache;
}

/** Strip reminder filler words from both ends of a title candidate. */
function cleanTitle(raw) {
  const words = fillerWords();
  let title = String(raw || "").replace(/\s{2,}/g, " ").trim();

  for (let guard = 0; guard < 8; guard++) {
    let changed = false;
    for (let i = 0; i < words.fillers.length; i++) {
      const p = words.fillers[i];
      if (title.length < p.length || title.slice(0, p.length) !== p) continue;
      const next = title[p.length];
      if (next === undefined || next === " " || next === "\u060C") {
        title = title.slice(p.length).trim();
        changed = true;
        break;
      }
    }
    for (let i = 0; i < words.trailers.length; i++) {
      const p = words.trailers[i];
      if (title.length >= p.length && title.slice(-p.length) === p) {
        const before = title[title.length - p.length - 1];
        if (before === undefined || before === " " || before === "\u060C") {
          title = title.slice(0, title.length - p.length).trim();
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }

  title = title.replace(/^[\s,\u060C:.!\u061F\-\u2014\u2013]+/, "").replace(/[\s,\u060C:\u061B]+$/, "");
  title = title.replace(/\s+(\u0631\u0627|\u0631\u0648)$/, "");
  return title.trim();
}

// --- Entry point -----------------------------------------------------------

function pushMatched(result, cursor, type, normStart, normEnd, value) {
  const range = originalRange(cursor.map, normStart, normEnd);
  result.matched.push({
    type: type,
    text: range ? cursor.original.slice(range.start, range.end).trim() : cursor.norm.slice(normStart, normEnd),
    value: value
  });
}

/**
 * Parse a natural-language reminder request.
 *
 * @param {string} text    raw user text (a leading slash command is allowed)
 * @param {object} options { nowMs, timezone, lang }
 * @returns {object}       see the module header
 */
export function parseReminder(text, options) {
  const opts = options || {};
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const tz = opts.timezone || null;
  const original = String(text || "");
  const lang = opts.lang || detectLang(original);

  const result = {
    ok: false, at: null, atSeconds: null, tz: tz, lang: lang,
    title: "", description: null, recurrence: null,
    matched: [], ambiguous: [], missing: null, error: null,
    assumedDate: null, assumedTime: null, dstAmbiguous: false,
    unsupported: null, suggestionMs: null, partial: null,
    hadTime: false, hadDate: false
  };

  if (!tz || !isValidTimeZone(tz)) {
    result.missing = "timezone";
    return result;
  }

  const cursor = createCursor(stripLeadingCommand(original));
  const nowParts = zonedParts(nowMs, tz);

  // Recurrence phrasing we cannot honour must be refused BEFORE any matching,
  // otherwise a partial match would silently produce a different schedule.
  const unsupported = detectUnsupportedRecurrence(original);
  if (unsupported) {
    result.error = "unsupported_recurrence";
    result.unsupported = unsupported;
    return finalize(result, cursor, nowMs);
  }

  // 1. Recurrence.
  const recHit = matchRecurrence(cursor);
  let impliedHour = null;
  if (recHit && recHit.recurrence) {
    result.recurrence = recHit.recurrence;
    if (recHit.impliedHour !== null && recHit.impliedHour !== undefined) impliedHour = recHit.impliedHour;
    pushMatched(result, cursor, "recurrence", recHit.start, recHit.end, result.recurrence);
    consume(cursor, recHit.start, recHit.end);
  }

  const recurrence = result.recurrence;
  const hasRecurrence = recurrence !== null;

  // 2. Relative duration.
  const duration = matchDuration(cursor);

  // 3. Calendar date. Matched and consumed BEFORE the clock is read, so a
  //    numeric date such as "1404.5.12" can never be misread as a clock time.
  const named = matchNamedDate(cursor) || matchNumericDate(cursor);
  if (named) {
    // The day may precede the month ("۱۲ مرداد" vs "مرداد ۱۲"), so the consumed
    // block is the outermost edges of all spans, not the first-to-last span.
    const bounds = spanBounds(named.spans);
    pushMatched(result, cursor, "date", bounds.start, bounds.end, named);
    for (let i = 0; i < named.spans.length; i++) consume(cursor, named.spans[i].start, named.spans[i].end);
    // "دوشنبه ۱۲ مرداد": a weekday alongside an explicit date is a comment on
    // that date, so it is consumed and ignored rather than used for a search.
    const extraWeekday = matchWeekday(cursor);
    if (extraWeekday) {
      pushMatched(result, cursor, "date", extraWeekday.start, extraWeekday.end, "weekday");
      consume(cursor, extraWeekday.start, extraWeekday.end);
    }
    result.hadDate = true;
  }

  const dayWord = named ? null : matchDayWord(cursor);
  let weekday = null;
  let dayWordWeekday = null;
  if (!named) {
    if (dayWord) {
      const wd = matchWeekday(cursor);
      if (wd && wd.start >= dayWord.end) dayWordWeekday = wd;
    }
    if (!dayWord) weekday = matchWeekday(cursor);
  }

  // Week-spanning words are unusable without a weekday.
  if (dayWord && (dayWord.value === "next_week" || dayWord.value === "this_week" || dayWord.value === "weekend") && !dayWordWeekday) {
    pushMatched(result, cursor, "date", dayWord.start, dayWord.end, dayWord.value);
    consume(cursor, dayWord.start, dayWord.end);
    result.error = "missing_weekday_for_week";
    result.missing = "date";
    return finalize(result, cursor, nowMs);
  }

  if (dayWord && !named) {
    const end = dayWordWeekday ? dayWordWeekday.end : dayWord.end;
    pushMatched(result, cursor, "date", dayWord.start, end, dayWord.value);
    consume(cursor, dayWord.start, end);
    result.hadDate = true;
  } else if (weekday && !named) {
    pushMatched(result, cursor, "date", weekday.start, weekday.end, "weekday");
    consume(cursor, weekday.start, weekday.end);
    result.hadDate = true;
  }

  // --- Reject a date that does not exist, before looking at the clock -------
  if (named) {
    const refJalaliYear = gregorianToJalali(nowParts.year, nowParts.month, nowParts.day).jy;
    const explicitYear = named.year !== null ? named.year
      : (named.calendar === "jalali" ? refJalaliYear : nowParts.year);
    if (!isValidNamedDate(named, explicitYear)) {
      result.error = "invalid_date";
      return finalize(result, cursor, nowMs);
    }
  }

  // 4. Clock time.
  const clock = duration ? null : resolveClock(cursor);
  if (clock) {
    if (clock.ambiguous) {
      result.ambiguous.push(meridiemAmbiguity(clock.hour, clock.text, cursor, clock.start, clock.end));
      // Consume anyway: the ambiguity is recorded, so leaving the wording in
      // place would only pollute the title.
      consume(cursor, clock.start, clock.end);
      pushMatched(result, cursor, "time", clock.start, clock.end, { hour: clock.hour, minute: clock.minute, ambiguous: true });
      result.missing = "time";
    } else {
      consume(cursor, clock.start, clock.end);
      pushMatched(result, cursor, "time", clock.start, clock.end, { hour: clock.hour, minute: clock.minute });
      result.hadTime = true;
    }
  }

  // A recurrence phrase may itself supply the hour ("هر روز صبح" -> 09:00).
  // That hour is treated exactly like a typed one, so the rest of the flow has
  // a single code path and a bare 1–12 is still reported as ambiguous.
  let recurrenceWithClock = null;
  if (hasRecurrence && impliedHour !== null && impliedHour !== undefined) {
    recurrenceWithClock = { hour: impliedHour, minute: 0 };
  }

  // --- Resolve the instant -------------------------------------------------
  const dateRef = { named: named, dayWord: dayWord, weekday: dayWordWeekday || weekday };

  if (duration) {
    consume(cursor, duration.start, duration.end);
    pushMatched(result, cursor, "duration", duration.start, duration.end, duration.ms);
    consumeAdjacentMarker(cursor, duration.start, duration.end);
    if (hasRecurrence) {
      // "هر ۳۰ دقیقه" / "every hour": the first run is one interval from now.
      const start = firstRecurrenceStart(nowMs, tz, recurrence, null, null);
      result.at = start === null ? nowMs + duration.ms : start;
      if (result.assumedTime === null) {
        result.assumedTime = { hour: nowParts.hour, minute: nowParts.minute };
      }
    } else {
      result.at = nowMs + duration.ms;
    }
  } else if (clock && !clock.ambiguous && result.hadDate) {
    const resolved = instantFromDate(tz, nowMs, nowParts, dateRef, clock);
    if (resolved.error) {
      result.error = resolved.error;
      if (resolved.suggestionMs !== undefined) result.suggestionMs = resolved.suggestionMs;
      return finalize(result, cursor, nowMs);
    }
    if (hasRecurrence && resolved.ms <= nowMs) {
      const next = firstRecurrenceStart(nowMs, tz, recurrence, clock.hour, clock.minute);
      result.at = next === null ? resolved.ms : next;
    } else {
      result.at = resolved.ms;
    }
    result.dstAmbiguous = !!resolved.dstAmbiguous;
  } else if (clock && !clock.ambiguous && hasRecurrence) {
    if (recurrence.weekday !== null) {
      // "every monday at 10" is the NEXT Monday at 10, not today.
      const resolved = instantFromDate(tz, nowMs, nowParts, { weekday: { value: recurrence.weekday } }, clock);
      result.at = resolved.error ? null : resolved.ms;
      if (resolved.error) result.error = resolved.error;
    } else {
      result.at = firstRecurrenceStart(nowMs, tz, recurrence, clock.hour, clock.minute);
    }
  } else if (clock && !clock.ambiguous) {
    // Time with no date: today when still ahead, otherwise tomorrow.
    const resolved = instantTimeOnly(tz, nowMs, nowParts, clock);
    if (resolved.error) {
      result.error = resolved.error;
      return finalize(result, cursor, nowMs);
    }
    result.at = resolved.ms;
    result.assumedDate = resolved.assumedDate;
    result.dstAmbiguous = !!resolved.dstAmbiguous;
  } else if (hasRecurrence) {
    const shortBucket = recurrence.bucket === "hour" || recurrence.bucket === "minute";
    if (shortBucket) {
      result.at = firstRecurrenceStart(nowMs, tz, recurrence, null, null);
    } else if (recurrenceWithClock) {
      // An hour supplied by the phrase itself is already 24-hour ("هر روز عصر"
      // is 17:00), so it is never ambiguous — only a typed bare hour is.
      if (recurrence.weekday !== null) {
        const resolved = instantFromDate(tz, nowMs, nowParts, { weekday: { value: recurrence.weekday } }, recurrenceWithClock);
        result.at = resolved.error ? null : resolved.ms;
        if (resolved.error) result.error = resolved.error;
      } else {
        result.at = firstRecurrenceStart(nowMs, tz, recurrence, recurrenceWithClock.hour, recurrenceWithClock.minute);
      }
    } else {
      // "هر روز" alone carries no time of day: ask rather than pick one.
      result.missing = "time";
    }
  } else if (result.hadDate) {
    result.missing = "time";
  } else if (result.ambiguous.length === 0) {
    result.missing = "datetime";
  }

  if (result.at !== null) {
    if (result.at <= nowMs) result.error = "past";
    else if (result.at - nowMs > MAX_HORIZON_MS) result.error = "too_far";
  }

  return finalize(result, cursor, nowMs);
}

/** Compose an instant from a date reference plus a clock time. */
function instantFromDate(tz, nowMs, nowParts, date, clock) {
  if (date.named) return instantFromNamedDate(tz, nowMs, nowParts, date.named, clock);
  if (date.dayWord) return instantFromDayWord(tz, nowMs, nowParts, date.dayWord, date.weekday, clock);
  if (date.weekday) {
    const resolved = resolveLocalToUtc(tz, nowParts.year, nowParts.month, nowParts.day, clock.hour, clock.minute, 0);
    if (resolved.kind === "nonexistent") return { error: "nonexistent_local_time", suggestionMs: resolved.suggestionMs };
    let ms = resolved.ms;
    for (let guard = 0; guard < 8 && (zonedParts(ms, tz).weekday !== date.weekday.value || ms <= nowMs); guard++) {
      ms = addLocalDays(tz, ms, 1);
    }
    return { ms: ms };
  }
  return { error: "invalid_date" };
}

function instantFromNamedDate(tz, nowMs, nowParts, spec, clock) {
  if (spec.calendar === "jalali") {
    if (spec.year !== null) {
      const g = jalaliToGregorian(spec.year, spec.month, spec.day);
      if (!g) return { error: "invalid_date" };
      return toInstant(resolveLocalToUtc(tz, g.year, g.month, g.day, clock.hour, clock.minute, 0));
    }
    const jy = gregorianToJalali(nowParts.year, nowParts.month, nowParts.day).jy;
    let g = jalaliToGregorian(jy, spec.month, spec.day);
    if (!g) return { error: "invalid_date" };
    if (instantMs(resolveLocalToUtc(tz, g.year, g.month, g.day, clock.hour, clock.minute, 0)) <= nowMs) {
      // Roll forward a year only when that date exists in the next Jalali year
      // too — otherwise keep the past instant and let the caller report it.
      const next = jalaliToGregorian(jy + 1, spec.month, spec.day);
      if (next) g = next;
    }
    return toInstant(resolveLocalToUtc(tz, g.year, g.month, g.day, clock.hour, clock.minute, 0));
  }

  if (spec.year !== null) {
    return toInstant(resolveLocalToUtc(tz, spec.year, spec.month, spec.day, clock.hour, clock.minute, 0));
  }
  let gy = nowParts.year;
  if (instantMs(resolveLocalToUtc(tz, gy, spec.month, spec.day, clock.hour, clock.minute, 0)) <= nowMs) gy += 1;
  return toInstant(resolveLocalToUtc(tz, gy, spec.month, spec.day, clock.hour, clock.minute, 0));
}

/** Named Jalali date rollover: a date already past this year moves to next year. */

/**
 * Day-word resolution. The instant is returned exactly as asked for — a "today"
 * time that already passed is reported as `past` rather than quietly moved to
 * tomorrow, because the user explicitly named the day.
 */
function instantFromDayWord(tz, nowMs, nowParts, dayWord, weekdayRef, clock) {
  const value = dayWord.value;
  const base = resolveLocalToUtc(tz, nowParts.year, nowParts.month, nowParts.day, clock.hour, clock.minute, 0);
  if (base.kind === "nonexistent") return { error: "nonexistent_local_time", suggestionMs: base.suggestionMs };
  let ms = base.ms;
  if (value === "tomorrow") {
    const next = addLocalDays(tz, ms, 1);
    if (!Number.isFinite(next)) return { error: "nonexistent_local_time" };
    return { ms: next };
  }
  if (value === "day_after_tomorrow") {
    const next = addLocalDays(tz, ms, 2);
    if (!Number.isFinite(next)) return { error: "nonexistent_local_time" };
    return { ms: next };
  }
  if (value === "today") {
    if (weekdayRef) {
      for (let guard = 0; guard < 8 && (zonedParts(ms, tz).weekday !== weekdayRef.value || ms <= nowMs); guard++) {
        ms = addLocalDays(tz, ms, 1);
      }
    }
    return { ms: ms };
  }
  // next_week / this_week / weekend always carry a weekday by this point.
  const target = weekdayRef ? weekdayRef.value : null;
  if (value === "next_week") ms = addLocalDays(tz, ms, 7);
  if (target !== null) {
    for (let guard = 0; guard < 8 && zonedParts(ms, tz).weekday !== target; guard++) ms = addLocalDays(tz, ms, 1);
  }
  if (ms <= nowMs) ms = addLocalDays(tz, ms, 7);
  return { ms: ms };
}

/**
 * Time without a date: today when still ahead, otherwise tomorrow.
 *
 * The applied default is reported in `assumedDate` so the confirmation can show
 * it; it is never applied silently. A `todayOnly` period word ("tonight") keeps
 * today even when the time has passed, so the user is told rather than moved.
 */
function instantTimeOnly(tz, nowMs, nowParts, clock) {
  const today = resolveLocalToUtc(tz, nowParts.year, nowParts.month, nowParts.day, clock.hour, clock.minute, 0);
  if (clock.todayOnly) {
    const ms = today.kind === "nonexistent" ? today.suggestionMs : today.ms;
    return { ms: ms, assumedDate: "today", dstAmbiguous: today.kind === "ambiguous" };
  }
  if (today.kind !== "nonexistent" && today.ms > nowMs) {
    return { ms: today.ms, assumedDate: "today", dstAmbiguous: today.kind === "ambiguous" };
  }
  const tomorrow = resolveLocalToUtc(tz, nowParts.year, nowParts.month, nowParts.day + 1, clock.hour, clock.minute, 0);
  if (tomorrow.kind === "nonexistent") return { error: "nonexistent_local_time" };
  return { ms: tomorrow.ms, assumedDate: "tomorrow", dstAmbiguous: tomorrow.kind === "ambiguous" };
}

function toInstant(resolved) {
  if (resolved.kind === "nonexistent") {
    return { error: "nonexistent_local_time", suggestionMs: resolved.suggestionMs };
  }
  return { ms: resolved.ms, dstAmbiguous: resolved.kind === "ambiguous" };
}

/** Build the title/description and settle `ok`. */
function finalize(result, cursor, nowMs) {
  const original = cursor.original;
  const ranges = consumedRanges(cursor);
  const sep = DESCRIPTION_SEP_RE.exec(original);
  const titleEnd = sep ? sep.index : original.length;
  const descStart = sep ? sep.index + sep[0].length : original.length;

  const title = cleanTitle(stripRanges(original, ranges, 0, titleEnd));
  const descRaw = descStart < original.length ? stripRanges(original, ranges, descStart, original.length) : "";
  const description = descRaw ? descRaw.replace(/\s{2,}/g, " ").trim() : "";

  result.title = title.slice(0, MAX_REMINDER_TITLE);
  result.description = description ? description.slice(0, MAX_REMINDER_DESCRIPTION) : null;
  result.partial = {
    title: result.title || null,
    at: result.at,
    recurrence: result.recurrence,
    hadDate: result.hadDate,
    hadTime: result.hadTime,
    matched: result.matched
  };

  if (result.error === null && result.missing === null && result.at !== null && result.at > nowMs) {
    if (!result.title) result.missing = "title";
    else {
      result.ok = true;
      result.atSeconds = Math.floor(result.at / 1000);
    }
  }
  return result;
}

// Re-exported so callers can advance/describe a stored recurrence without
// reaching into schedule.js directly.
export { normalizeRecurrence, normalizeBucket, firstRecurrenceStart };
