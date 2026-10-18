// Language data for the reminder parser: numerals, number words, calendar
// month and weekday names, time-of-day periods, duration units, recurrence
// phrases and reminder-intent cues — in Persian and English.
//
// Kept apart from `parse.js` so the matcher stays readable and the vocabulary
// can be extended (a new colloquialism, a localised month name) without
// touching any parsing logic.
//
// `normalizeForMatch` produces a matching string whose character indices map
// back to the ORIGINAL text, so the parser can delete exactly the span it
// matched from the reminder title while still matching case-insensitively,
// digit-insensitively and diacritic-insensitively.

const DIACRITICS = /[\u064B-\u0652\u0670\u0640]/;

const DIGIT_MAP = {
  "\u06F0": "0", "\u06F1": "1", "\u06F2": "2", "\u06F3": "3", "\u06F4": "4",
  "\u06F5": "5", "\u06F6": "6", "\u06F7": "7", "\u06F8": "8", "\u06F9": "9",
  "\u0660": "0", "\u0661": "1", "\u0662": "2", "\u0663": "3", "\u0664": "4",
  "\u0665": "5", "\u0666": "6", "\u0667": "7", "\u0668": "8", "\u0669": "9"
};

/** Convert Persian and Arabic-Indic digits to ASCII digits. */
export function normalizeDigits(input) {
  if (!input) return "";
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    out += DIGIT_MAP[ch] !== undefined ? DIGIT_MAP[ch] : ch;
  }
  return out;
}

/**
 * Build a case/digit/diacritic-normalised copy of `text` plus an index map.
 *
 * `text[i]` corresponds to original character `map[i]`. ZWNJ and other zero
 * width joiners become a normal space so "نیم‌ساعت" and "نیم ساعت" match the
 * same pattern; Arabic yeh/kaf are folded to their Persian forms.
 */
export function normalizeForMatch(input) {
  const chars = [];
  const map = [];
  const src = String(input || "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (DIACRITICS.test(ch)) continue;
    let out = ch;
    if (DIGIT_MAP[ch] !== undefined) out = DIGIT_MAP[ch];
    else if (ch === "\u064A" || ch === "\u0649" || ch === "\u06CC") out = "\u06CC"; // ي ى -> ی
    else if (ch === "\u0643") out = "\u06A9"; // ك -> ک
    else if (ch === "\u0629") out = "\u0647"; // ة -> ه
    else if (ch === "\u200C" || ch === "\u200B" || ch === "\uFEFF") out = " ";
    out = out.toLowerCase();
    chars.push(out);
    map.push(i);
  }
  return { text: chars.join(""), map: map };
}

/** Map a [start, end) span of the normalised text back onto the original. */
export function originalRange(map, start, end) {
  if (end <= start) return null;
  const from = map[start];
  const to = map[end - 1];
  if (from === undefined || to === undefined) return null;
  return { start: from, end: to + 1 };
}

/** Pairs of (phrase, value), sorted longest-phrase-first for greedy matching. */
function byPhrase(map) {
  return Object.keys(map)
    .sort(function (a, b) { return b.length - a.length; })
    .map(function (key) { return { phrase: key, value: map[key] }; });
}

// --- Numerals --------------------------------------------------------------

/** Persian number words, including the forms used in durations and ordinals. */
export const PERSIAN_NUMBERS = {
  "صفر": 0, "یک": 1, "دو": 2, "سه": 3, "چهار": 4, "پنج": 5, "شش": 6, "هفت": 7,
  "هشت": 8, "نه": 9, "ده": 10, "یازده": 11, "دوازده": 12, "سیزده": 13,
  "چهارده": 14, "پانزده": 15, "شانزده": 16, "هفده": 17, "هجده": 18, "نوزده": 19,
  "بیست": 20, "سی": 30, "چهل": 40, "پنجاه": 50, "شصت": 60, "هفتاد": 70,
  "هشتاد": 80, "نود": 90, "صد": 100, "نیم": 0.5, "ربع": 0.25, "نصف": 0.5
};

/** English number words used by durations. */
export const ENGLISH_NUMBERS = {
  "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
  "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
  "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17,
  "eighteen": 18, "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40,
  "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
  "hundred": 100, "a": 1, "an": 1, "half": 0.5, "quarter": 0.25,
  "couple": 2, "one and a half": 1.5
};

/**
 * Persian ordinals 1..31. "سی‌ام" folds to "سی ام" under normalisation, so the
 * spaced forms are listed explicitly.
 */
export const PERSIAN_ORDINALS = {
  "اول": 1, "یکم": 1,
  "دوم": 2, "دومین": 2, "دویم": 2,
  "سوم": 3, "سویم": 3,
  "چهارم": 4, "چهارمین": 4,
  "پنجم": 5, "پنجمین": 5,
  "ششم": 6, "ششمین": 6,
  "هفتم": 7, "هفتمین": 7,
  "هشتم": 8, "هشتمین": 8,
  "نهم": 9, "نهمین": 9,
  "دهم": 10, "دهمین": 10,
  "یازدهم": 11, "دوازدهم": 12, "سیزدهم": 13, "چهاردهم": 14, "پانزدهم": 15,
  "شانزدهم": 16, "هفدهم": 17, "هجدهم": 18, "نوزدهم": 19, "بیستم": 20,
  "بیست و یکم": 21, "بیست و دوم": 22, "بیست و سوم": 23, "بیست و چهارم": 24,
  "بیست و پنجم": 25, "بیست و ششم": 26, "بیست و هفتم": 27, "بیست و هشتم": 28,
  "بیست و نهم": 29, "سی ام": 30, "سی‌ام": 30, "سی اُم": 30,
  "سی و یکم": 31, "سی و یک": 31
};

// --- Calendar --------------------------------------------------------------

/** Jalali months, index 0 = فروردین. Aliases include the common variants. */
export const JALALI_MONTHS = [
  ["فروردین", "فروردين"],
  ["اردیبهشت", "ارديبهشت"],
  ["خرداد"],
  ["تیر"],
  ["مرداد", "امرداد"],
  ["شهریور", "شهريور"],
  ["مهر"],
  ["آبان"],
  ["آذر"],
  ["دی", "دى"],
  ["بهمن"],
  ["اسفند", "اسپند"]
];

/** Persian names for the Gregorian months, index 0 = January. */
export const GREGORIAN_MONTHS_FA = [
  ["ژانویه", "ژانويه"],
  ["فوریه", "فوريه"],
  ["مارس"],
  ["آوریل", "آپریل", "اپریل"],
  ["مه", "می"],
  ["ژوئن"],
  ["ژوئیه", "جولای", "جولاى"],
  ["اوت", "آگوست"],
  ["سپتامبر"],
  ["اکتبر"],
  ["نوامبر"],
  ["دسامبر"]
];

export const GREGORIAN_MONTHS_EN = [
  ["january", "jan"], ["february", "feb"], ["march", "mar"], ["april", "apr"],
  ["may"], ["june", "jun"], ["july", "jul"], ["august", "aug"],
  ["september", "sep", "sept"], ["october", "oct"], ["november", "nov"], ["december", "dec"]
];

function flattenMonths(groups) {
  const out = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = 0; j < groups[i].length; j++) out.push({ phrase: groups[i][j], value: i + 1 });
  }
  return out.sort(function (a, b) { return b.phrase.length - a.phrase.length; });
}

/** Longest-first month match tables: `{ phrase, value }` with 1-based months. */
export const JALALI_MONTH_LOOKUP = flattenMonths(JALALI_MONTHS);
export const GREGORIAN_MONTH_LOOKUP = flattenMonths(GREGORIAN_MONTHS_FA).concat(flattenMonths(GREGORIAN_MONTHS_EN));

/**
 * Weekday aliases. Values use JavaScript's `Date#getDay()` convention
 * (0 = Sunday … 6 = Saturday), which is also what `tz.js:weekdayOf` returns.
 *
 * `full` names may appear anywhere in the text; the short English forms are
 * only accepted after a relative-day marker ("next mon", "on fri", "every tue")
 * so that ordinary words like "sat" or "sun" are not swallowed as weekdays.
 */
export const WEEKDAY_LOOKUP = [
  { phrase: "یکشنبه", value: 0, short: false },
  { phrase: "یک شنبه", value: 0, short: false },
  { phrase: "دوشنبه", value: 1, short: false },
  { phrase: "دو شنبه", value: 1, short: false },
  { phrase: "سه شنبه", value: 2, short: false },
  { phrase: "سهشنبه", value: 2, short: false },
  { phrase: "چهارشنبه", value: 3, short: false },
  { phrase: "چهار شنبه", value: 3, short: false },
  { phrase: "پنجشنبه", value: 4, short: false },
  { phrase: "پنج شنبه", value: 4, short: false },
  { phrase: "پنج‌شنبه", value: 4, short: false },
  { phrase: "جمعه", value: 5, short: false },
  { phrase: "آدینه", value: 5, short: false },
  { phrase: "شنبه", value: 6, short: false },
  { phrase: "sunday", value: 0, short: false },
  { phrase: "monday", value: 1, short: false },
  { phrase: "tuesday", value: 2, short: false },
  { phrase: "wednesday", value: 3, short: false },
  { phrase: "thursday", value: 4, short: false },
  { phrase: "friday", value: 5, short: false },
  { phrase: "saturday", value: 6, short: false },
  { phrase: "sun", value: 0, short: true },
  { phrase: "mon", value: 1, short: true },
  { phrase: "tue", value: 2, short: true },
  { phrase: "tues", value: 2, short: true },
  { phrase: "wed", value: 3, short: true },
  { phrase: "thu", value: 4, short: true },
  { phrase: "thur", value: 4, short: true },
  { phrase: "thurs", value: 4, short: true },
  { phrase: "fri", value: 5, short: true },
  { phrase: "sat", value: 6, short: true }
].sort(function (a, b) { return b.phrase.length - a.phrase.length; });

// --- Day words -------------------------------------------------------------

export const DAY_WORDS = [
  { phrase: "پس فردا", value: "day_after_tomorrow" },
  { phrase: "پس‌فردا", value: "day_after_tomorrow" },
  { phrase: "پسفردا", value: "day_after_tomorrow" },
  { phrase: "day after tomorrow", value: "day_after_tomorrow" },
  { phrase: "فردا", value: "tomorrow" },
  { phrase: "فردا", value: "tomorrow" },
  { phrase: "tomorrow", value: "tomorrow" },
  { phrase: "tmrw", value: "tomorrow" },
  { phrase: "tomorow", value: "tomorrow" },
  { phrase: "امروز", value: "today" },
  { phrase: "today", value: "today" }
].sort(function (a, b) { return b.phrase.length - a.phrase.length; });

/** Relative-day markers that legitimise a short English weekday ("next mon"). */
export const DAY_MARKERS_EN = ["next", "this", "on", "coming", "every", "تا", "این"];

// --- Time of day -----------------------------------------------------------

/**
 * Period words. `hour` is the default hour when no numeric hour is given;
 * `meridiem` applies to a 12-hour number that follows ("۸ شب" -> 20:00);
 * `boundary` marks periods that snap an hour to a fixed value ("ظهر" -> 12:00).
 */
export const PERIOD_LOOKUP = [
  { phrase: "نیمه شب", hour: 0, meridiem: "midnight", defaultHour: 0, approx: "midnight" },
  { phrase: "نصف شب", hour: 0, meridiem: "midnight", defaultHour: 0, approx: "midnight" },
  { phrase: "بعد از ظهر", hour: 15, meridiem: "pm", defaultHour: 15, approx: "afternoon" },
  { phrase: "بعدازظهر", hour: 15, meridiem: "pm", defaultHour: 15, approx: "afternoon" },
  { phrase: "بعداز ظهر", hour: 15, meridiem: "pm", defaultHour: 15, approx: "afternoon" },
  { phrase: "بعدظهر", hour: 15, meridiem: "pm", defaultHour: 15, approx: "afternoon" },
  { phrase: "بامداد", hour: 6, meridiem: "am", defaultHour: 6, approx: "early morning" },
  { phrase: "صبح", hour: 9, meridiem: "am", defaultHour: 9, approx: "morning" },
  { phrase: "ظهر", hour: 12, meridiem: "pm", defaultHour: 12, approx: "noon" },
  { phrase: "عصر", hour: 17, meridiem: "pm", defaultHour: 17, approx: "afternoon" },
  { phrase: "غروب", hour: 18, meridiem: "pm", defaultHour: 18, approx: "evening" },
  { phrase: "شب", hour: 21, meridiem: "pm", defaultHour: 21, approx: "evening" },
  { phrase: "در ابتدای روز", hour: 9, meridiem: "am", defaultHour: 9, approx: "morning" },
  { phrase: "in the morning", hour: 9, meridiem: "am", defaultHour: 9, approx: "morning" },
  { phrase: "in the afternoon", hour: 15, meridiem: "pm", defaultHour: 15, approx: "afternoon" },
  { phrase: "in the evening", hour: 19, meridiem: "pm", defaultHour: 19, approx: "evening" },
  { phrase: "at night", hour: 21, meridiem: "pm", defaultHour: 21, approx: "evening" },
  { phrase: "tonight", hour: 21, meridiem: "pm", defaultHour: 21, approx: "evening", todayOnly: true },
  { phrase: "this morning", hour: 9, meridiem: "am", defaultHour: 9, approx: "morning", todayOnly: true },
  { phrase: "this afternoon", hour: 15, meridiem: "pm", defaultHour: 15, approx: "afternoon", todayOnly: true },
  { phrase: "this evening", hour: 19, meridiem: "pm", defaultHour: 19, approx: "evening", todayOnly: true },
  { phrase: "midnight", hour: 0, meridiem: "midnight", defaultHour: 0, approx: "midnight" },
  { phrase: "midday", hour: 12, meridiem: "pm", defaultHour: 12, approx: "noon" },
  { phrase: "noon", hour: 12, meridiem: "pm", defaultHour: 12, approx: "noon" },
  { phrase: "morning", hour: 9, meridiem: "am", defaultHour: 9, approx: "morning", requiresIn: true },
  { phrase: "afternoon", hour: 15, meridiem: "pm", defaultHour: 15, approx: "afternoon", requiresIn: true },
  { phrase: "evening", hour: 19, meridiem: "pm", defaultHour: 19, approx: "evening", requiresIn: true }
].sort(function (a, b) { return b.phrase.length - a.phrase.length; });

/** Period words that only make sense as "tonight" when no date was given. */
export const NIGHT_WORDS = ["امشب", "tonight", "tonight at", "شب"];

// --- Durations -------------------------------------------------------------

/**
 * Duration units in milliseconds. Multi-word units are listed explicitly
 * because the parser matches literal phrases, not a grammar.
 */
export const DURATION_UNITS = {
  "ثانیه": 1000, "ثانيه": 1000, "second": 1000, "seconds": 1000, "sec": 1000, "secs": 1000, "s": 1000,
  "دقیقه": 60000, "دقيقه": 60000, "دقه": 60000, "دقیقه ای": 60000, "minute": 60000, "minutes": 60000, "min": 60000, "mins": 60000, "m": 60000,
  "ساعت": 3600000, "ساعته": 3600000, "hour": 3600000, "hours": 3600000, "hr": 3600000, "hrs": 3600000, "h": 3600000,
  "روز": 86400000, "روزه": 86400000, "day": 86400000, "days": 86400000, "d": 86400000,
  "هفته": 604800000, "هفته ای": 604800000, "week": 604800000, "weeks": 604800000, "w": 604800000,
  "ماه": 2592000000, "ماهه": 2592000000, "month": 2592000000, "months": 2592000000,
  "سال": 31536000000, "ساله": 31536000000, "year": 31536000000, "years": 31536000000
};

/** Phrase pairs that mean a duration on their own, without a preceding number. */
export const STANDALONE_DURATIONS = [
  { phrase: "نیم ساعت", ms: 1800000 },
  { phrase: "نیمساعت", ms: 1800000 },
  { phrase: "ربع ساعت", ms: 900000 },
  { phrase: "یک ربع", ms: 900000 },
  { phrase: "ربع", ms: 900000 },
  { phrase: "نیم ساعت و ربع", ms: 2700000 },
  { phrase: "یک ساعت و نیم", ms: 5400000 },
  { phrase: "یک ساعت و ربع", ms: 4500000 },
  { phrase: "ساعت و نیم", ms: 5400000 },
  { phrase: "یک روز و نیم", ms: 129600000 },
  { phrase: "half an hour", ms: 1800000 },
  { phrase: "half hour", ms: 1800000 },
  { phrase: "an hour and a half", ms: 5400000 },
  { phrase: "quarter of an hour", ms: 900000 },
  { phrase: "a quarter of an hour", ms: 900000 }
].sort(function (a, b) { return b.phrase.length - a.phrase.length; });

/** Words that introduce a future-relative duration. */
export const RELATIVE_MARKERS = [
  { phrase: "بعد از", direction: "after" },
  { phrase: "دیگر", direction: "after" },
  { phrase: "دیگه", direction: "after" },
  { phrase: "بعد", direction: "after" },
  { phrase: "پس از", direction: "after" },
  { phrase: "from now", direction: "after" },
  { phrase: "later", direction: "after" },
  { phrase: "in", direction: "after" },
  { phrase: "after", direction: "after" },
  { phrase: "تا", direction: "after" }
].sort(function (a, b) { return b.phrase.length - a.phrase.length; });

/** Alternative bucket aliases used by recurrence phrases. */
export const RECURRENCE_PHRASES = [
  { phrase: "هر روز صبح", bucket: "day", interval: 1, hour: 9 },
  { phrase: "every morning", bucket: "day", interval: 1, hour: 9 },
  { phrase: "هر روز عصر", bucket: "day", interval: 1, hour: 17 },
  { phrase: "هر روز ظهر", bucket: "day", interval: 1, hour: 12 },
  { phrase: "هر روز شب", bucket: "day", interval: 1, hour: 21 },
  { phrase: "هر روز", bucket: "day", interval: 1 },
  { phrase: "روزانه", bucket: "day", interval: 1 },
  { phrase: "each day", bucket: "day", interval: 1 },
  { phrase: "every day", bucket: "day", interval: 1 },
  { phrase: "daily", bucket: "day", interval: 1 },
  { phrase: "هر روزه", bucket: "day", interval: 1 },
  { phrase: "هر هفته", bucket: "week", interval: 1 },
  { phrase: "هفته ای یک بار", bucket: "week", interval: 1 },
  { phrase: "هفته‌ای یک بار", bucket: "week", interval: 1 },
  { phrase: "هفتگی", bucket: "week", interval: 1 },
  { phrase: "every week", bucket: "week", interval: 1 },
  { phrase: "weekly", bucket: "week", interval: 1 },
  { phrase: "هر ماه", bucket: "month", interval: 1 },
  { phrase: "ماهانه", bucket: "month", interval: 1 },
  { phrase: "ماهیانه", bucket: "month", interval: 1 },
  { phrase: "every month", bucket: "month", interval: 1 },
  { phrase: "monthly", bucket: "month", interval: 1 },
  { phrase: "هر سال", bucket: "year", interval: 1 },
  { phrase: "سالانه", bucket: "year", interval: 1 },
  { phrase: "سال‌یانه", bucket: "year", interval: 1 },
  { phrase: "every year", bucket: "year", interval: 1 },
  { phrase: "yearly", bucket: "year", interval: 1 },
  { phrase: "annually", bucket: "year", interval: 1 },
  { phrase: "هر ساعت", bucket: "hour", interval: 1 },
  { phrase: "ساعتی", bucket: "hour", interval: 1 },
  { phrase: "every hour", bucket: "hour", interval: 1 },
  { phrase: "hourly", bucket: "hour", interval: 1 },
  { phrase: "هر دقیقه", bucket: "minute", interval: 1 },
  { phrase: "every minute", bucket: "minute", interval: 1 }
].sort(function (a, b) { return b.phrase.length - a.phrase.length; });

export const RECURRENCE_MARKERS = ["هر", "every", "each", "any"];
export const EVERY_OTHER_WORDS = ["other", "دیگر", "یک در میان", "یک‌درمیان", " alternate", "alternate"];

// --- Reminder intent -------------------------------------------------------

/**
 * Cues that mark a message as a reminder request. NL creation is deliberately
 * gated on these: a private message that merely mentions a time ("فردا ساعت ۵
 * جلسه دارم") is conversation, not a command, and must reach the AI unchanged.
 */
export const REMINDER_CUES = [
  "یادم بنداز", "یادم بیار", "بهم یادآوری کن", "به من یادآوری کن", "یادآوری کن",
  "یادآوری", "یادم بندازید", "یادم بیانداز", "یادم بینداز", "یادم بنداز که",
  "alarm", "آلارم", "تذکر بده", "خبرم کن", "اطلاع بده", "نوتیف", "notification",
  "remind me", "reminder", "set a reminder", "remind", "notify me", "ping me"
];

/** Leading filler removed from the generated title. */
export const TITLE_FILLERS = [
  "به من یادآوری کن که", "بهم یادآوری کن که", "یادم بنداز که", "یادم بیار که",
  "به من یادآوری کن", "بهم یادآوری کن", "یادآوری کن که", "یادآوری کن",
  "یادم بنداز", "یادم بیار", "یادم بیانداز", "یادم بینداز",
  "remind me to", "remind me that", "remind me", "remind me about",
  "set a reminder to", "set a reminder for", "set a reminder", "reminder to",
  "reminder for", "reminder:", "remind to", "remind that", "remind",
  "notify me to", "notify me about", "notify me", "ping me to", "ping me about", "ping me",
  "that", "to", "about", "برای", "که", "در مورد", "درباره", "برای این‌که"
].sort(function (a, b) { return b.length - a.length; });

/** Trailing filler removed from the generated title ("… را یادآوری کن"). */
export const TITLE_TRAILERS = [
  "را یادآوری کن", "رو یادآوری کن", "را یادم بنداز", "رو یادم بنداز",
  "را یادم بیار", "رو یادم بیار", "یادآوری کن", "یادم بنداز", "یادم بیار",
  "remind me", "please", "لطفا", "لطفاً"
].sort(function (a, b) { return b.length - a.length; });

export { byPhrase };
