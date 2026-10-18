// Reminder message rendering.
//
// Every string the reminder subsystem sends to a user is built here, so the
// Persian and English surfaces stay in lockstep and nothing is assembled ad hoc
// at a call site. Two rules the whole module follows:
//
//   * Instants are stored as UTC seconds and only ever formatted in the *user's*
//     stored timezone, never the worker's. A worker runs in UTC, so using the
//     runtime clock would silently show every user a wrong hour — the exact bug
//     "never assume the server's timezone is the user's timezone" warns about.
//   * Every interpolated user value goes through `escapeHtml`, because the
//     messages are sent with `parse_mode: "HTML"`.
import { MAX_REMINDER_TITLE } from "../config.js";
import { escapeHtml } from "../utils.js";
import { gregorianToJalali } from "./jalali.js";
import { describeRecurrence, weekdayName } from "./schedule.js";
import { offsetLabel, zonedParts } from "./tz.js";

const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

const FA_JALALI_MONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];

const FA_GREGORIAN_MONTHS = ["ژانویه", "فوریه", "مارس", "آوریل", "مه", "ژوئن", "ژوئیه", "اوت", "سپتامبر", "اکتبر", "نوامبر", "دسامبر"];

const EN_GREGORIAN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const FA_STATUS = {
  pending: "فعال",
  processing: "در حال ارسال",
  sent: "ارسال‌شده",
  completed: "انجام‌شده",
  cancelled: "لغو‌شده",
  failed: "ناموفق"
};

const EN_STATUS = {
  pending: "active",
  processing: "sending",
  sent: "sent",
  completed: "done",
  cancelled: "cancelled",
  failed: "failed"
};

/** Render an integer with the digits the language uses. */
export function localDigits(value, lang) {
  const s = String(value);
  if (lang !== "fa") return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) - 48;
    out += (c >= 0 && c <= 9) ? FA_DIGITS[c] : s[i];
  }
  return out;
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

/**
 * `1404/05/12 14:30` for Persian (Jalali), `2026-05-03 14:30` for English.
 * Returns PLAIN text — callers escape it when the message uses HTML parse mode.
 * `withZone` appends the UTC offset the user's zone was at that instant, which
 * is what makes a DST edge visible in a confirmation.
 */
export function formatInstant(ms, tz, lang, opts) {
  const options = opts || {};
  const p = zonedParts(ms, tz);
  let date;
  if (lang === "fa") {
    const j = gregorianToJalali(p.year, p.month, p.day);
    date = localDigits(j.jy, lang) + "/" + localDigits(pad2(j.jm), lang) + "/" + localDigits(pad2(j.jd), lang);
  } else {
    date = p.year + "-" + pad2(p.month) + "-" + pad2(p.day);
  }
  let text = date + " " + localDigits(pad2(p.hour), lang) + ":" + localDigits(pad2(p.minute), lang);
  if (options.withZone !== false) {
    text += lang === "fa" ? " (به وقت " + tz + " " + offsetLabel(ms, tz) + ")" : " (" + tz + " " + offsetLabel(ms, tz) + ")";
  }
  return text;
}

/** Long-form date: `دوشنبه ۱۲ مرداد ۱۴۰۴` / `Monday, 3 May 2026`. */
export function formatDateLong(ms, tz, lang) {
  const p = zonedParts(ms, tz);
  const wd = weekdayName(p.weekday, lang);
  if (lang === "fa") {
    const j = gregorianToJalali(p.year, p.month, p.day);
    return wd + " " + localDigits(j.jd, lang) + " " + FA_JALALI_MONTHS[j.jm - 1] + " " + localDigits(j.jy, lang);
  }
  return wd + ", " + p.day + " " + EN_GREGORIAN_MONTHS[p.month - 1] + " " + p.year;
}

/** Short weekday + time: `دوشنبه ۱۴:۳۰` / `Monday 14:30`. */
export function formatShortWhen(ms, tz, lang) {
  const p = zonedParts(ms, tz);
  return weekdayName(p.weekday, lang) + " " + localDigits(pad2(p.hour), lang) + ":" + localDigits(pad2(p.minute), lang);
}

/** Persian Gregorian month name (used when a user picked the Gregorian calendar). */
export function gregorianMonthNameFa(month) {
  return FA_GREGORIAN_MONTHS[month - 1] || "";
}

export function statusLabel(status, lang) {
  const map = lang === "fa" ? FA_STATUS : EN_STATUS;
  return map[status] || status;
}

function title(text) {
  const clean = String(text || "").trim();
  return escapeHtml(clean.length > MAX_REMINDER_TITLE ? clean.slice(0, MAX_REMINDER_TITLE) : clean);
}

function lines(reminder, lang) {
  const out = [];
  out.push("<b>" + title(reminder.title) + "</b>");
  if (reminder.description) out.push(escapeHtml(reminder.description));
  out.push("⏰ " + escapeHtml(formatInstant(reminder.startAt * 1000, reminder.timezone, lang)));
  if (reminder.recurrence) {
    const rec = describeRecurrence(reminder.recurrence, lang);
    if (rec) out.push("🔁 " + escapeHtml(rec));
  }
  return out;
}

/**
 * Creation confirmation. Sent only after the row is actually persisted, so this
 * is never a promise the database did not keep.
 */
export function confirmationMessage(reminder, lang) {
  if (lang === "fa") {
    const out = ["✅ یادآور ثبت شد.", ""];
    out.push(...lines(reminder, "fa"));
    out.push("");
    out.push("شناسه: <code>" + reminder.id + "</code>");
    out.push("برای لغو: <code>/cancelreminder " + reminder.id + "</code>");
    return out.join("\n");
  }
  const out = ["✅ Reminder saved.", ""];
  out.push(...lines(reminder, "en"));
  out.push("");
  out.push("ID: <code>" + reminder.id + "</code>");
  out.push("To cancel: <code>/cancelreminder " + reminder.id + "</code>");
  return out.join("\n");
}

/**
 * Confirmation that also records an assumption the parser made, so the user can
 * correct it before it fires. The assumption is never hidden.
 */
export function assumedNotice(parseResult, lang) {
  if (!parseResult) return "";
  const parts = [];
  if (parseResult.assumedDate === "today") parts.push(lang === "fa" ? "امروز" : "today");
  if (parseResult.assumedDate === "tomorrow") parts.push(lang === "fa" ? "فردا" : "tomorrow");
  if (parseResult.dstAmbiguous) parts.push(lang === "fa" ? "ساعت مبهم پایان روز (تغییر ساعت)" : "ambiguous end-of-DST hour");
  if (!parts.length) return "";
  return lang === "fa"
    ? "ℹ️ فرض شد: " + parts.join("، ")
    : "ℹ️ Assumed: " + parts.join(", ");
}

/** One row in a list page. */
export function listItemMessage(reminder, lang, index) {
  const out = [];
  const marker = lang === "fa" ? localDigits(index, lang) + ". " : (index + ". ");
  out.push(marker + "<b>" + title(reminder.title) + "</b>");
  out.push("   <code>" + reminder.id + "</code> · " + escapeHtml(formatShortWhen(reminder.nextRunAt * 1000, reminder.timezone, lang)));
  if (reminder.recurrence) out.push("   🔁 " + escapeHtml(describeRecurrence(reminder.recurrence, lang)));
  if (reminder.status === "failed") {
    out.push("   ⚠️ " + (lang === "fa" ? "ارسال ناموفق" : "delivery failed"));
  }
  return out.join("\n");
}

/**
 * A page of reminders. `items` is the slice already fetched; `total` and
 * `hasMore` come from the caller so the header can say "8 of 23" honestly.
 */
export function listMessage(items, lang, total, hasMore) {
  if (!items || !items.length) {
    return lang === "fa"
      ? "📭 هیچ یادآور فعالی نداری.\n\nبرای ساخت: <code>/remind فردا ساعت ۹ جلسه</code>"
      : "📭 You have no active reminders.\n\nTo create one: <code>/remind tomorrow at 9 meeting</code>";
  }
  const out = [];
  out.push(lang === "fa"
    ? "<b>یادآورهای تو</b> (" + localDigits(items.length, lang) + " از " + localDigits(total, lang) + ")"
    : "<b>Your reminders</b> (" + items.length + " of " + total + ")");
  out.push("");
  for (let i = 0; i < items.length; i++) {
    out.push(listItemMessage(items[i], lang, i + 1));
    if (i < items.length - 1) out.push("");
  }
  if (hasMore) {
    out.push("");
    out.push(lang === "fa"
      ? "برای دیدن بقیه: <code>/reminders " + items[items.length - 1].id + "</code>"
      : "For more: <code>/reminders " + items[items.length - 1].id + "</code>");
  }
  return out.join("\n");
}

/** Single-reminder detail view. */
export function detailMessage(reminder, lang) {
  const out = [];
  out.push(lang === "fa" ? "<b>یادآور</b> <code>" + reminder.id + "</code>" : "<b>Reminder</b> <code>" + reminder.id + "</code>");
  out.push("");
  out.push("<b>" + title(reminder.title) + "</b>");
  if (reminder.description) out.push(escapeHtml(reminder.description));
  out.push("");
  out.push((lang === "fa" ? "زمان: " : "When: ") + escapeHtml(formatInstant(reminder.startAt * 1000, reminder.timezone, lang)));
  if (reminder.recurrence) {
    out.push((lang === "fa" ? "تکرار: " : "Repeats: ") + escapeHtml(describeRecurrence(reminder.recurrence, lang)));
    out.push((lang === "fa" ? "نوبت بعدی: " : "Next: ") + escapeHtml(formatInstant(reminder.nextRunAt * 1000, reminder.timezone, lang)));
  }
  out.push((lang === "fa" ? "وضعیت: " : "Status: ") + escapeHtml(statusLabel(reminder.status, lang)));
  if (reminder.attempts > 0 && reminder.status !== "sent" && reminder.status !== "completed") {
    out.push((lang === "fa" ? "تلاش‌های ارسال: " : "Delivery attempts: ") + localDigits(reminder.attempts, lang));
  }
  if (reminder.lastError && (reminder.status === "failed" || reminder.status === "pending")) {
    out.push((lang === "fa" ? "آخرین خطا: " : "Last error: ") + escapeHtml(String(reminder.lastError).slice(0, 200)));
  }
  out.push("");
  out.push(lang === "fa"
    ? "لغو: <code>/cancelreminder " + reminder.id + "</code>"
    : "Cancel: <code>/cancelreminder " + reminder.id + "</code>");
  return out.join("\n");
}

/** The message actually delivered when a reminder fires. */
export function dueMessage(reminder, lang) {
  const out = [];
  out.push(lang === "fa" ? "🔔 <b>یادآوری</b>" : "🔔 <b>Reminder</b>");
  out.push("");
  out.push("<b>" + title(reminder.title) + "</b>");
  if (reminder.description) out.push(escapeHtml(reminder.description));
  if (reminder.recurrence) {
    const rec = describeRecurrence(reminder.recurrence, lang);
    if (rec) out.push("");
    if (rec) out.push("🔁 " + escapeHtml(rec));
  }
  out.push("");
  out.push("<code>/donereminder " + reminder.id + "</code> · <code>/cancelreminder " + reminder.id + "</code>");
  return out.join("\n");
}

/** Notice that a recurring reminder was cancelled. */
export function cancelledMessage(reminder, lang) {
  if (!reminder) return lang === "fa" ? "یادآور پیدا نشد یا قبلاً لغو شده." : "Reminder not found or already cancelled.";
  return lang === "fa"
    ? "🗑 یادآور لغو شد: <b>" + title(reminder.title) + "</b> (<code>" + reminder.id + "</code>)"
    : "🗑 Cancelled: <b>" + title(reminder.title) + "</b> (<code>" + reminder.id + "</code>)";
}

export function completedMessage(reminder, lang) {
  if (!reminder) return lang === "fa" ? "یادآور پیدا نشد." : "Reminder not found.";
  return lang === "fa"
    ? "✅ انجام شد: <b>" + title(reminder.title) + "</b> (<code>" + reminder.id + "</code>)"
    : "✅ Done: <b>" + title(reminder.title) + "</b> (<code>" + reminder.id + "</code>)";
}

/**
 * Parser result → the string the user sees. Kept in one place so an error can
 * never leak an internal reason code into a chat.
 */
export function parseOutcomeMessage(parseResult, lang) {
  if (!parseResult) return lang === "fa" ? "متوجه نشدم. مثال: /remind فردا ساعت ۹ جلسه" : "I did not understand. Example: /remind tomorrow at 9 meeting";
  if (parseResult.error) {
    switch (parseResult.error) {
      case "invalid_date":
        return lang === "fa" ? "⚠️ آن تاریخ وجود ندارد. یک تاریخ معتبر بفرست." : "⚠️ That date does not exist. Please send a valid date.";
      case "past":
        return lang === "fa" ? "⚠️ آن زمان گذشته است. زمان دیگری بفرست." : "⚠️ That time is in the past. Please send a future time.";
      case "too_far":
        return lang === "fa" ? "⚠️ زمان بیش از حد دور است (حداکثر ۱۰ سال)." : "⚠️ That is too far ahead (10 years maximum).";
      case "nonexistent_local_time":
        return lang === "fa" ? "⚠️ آن ساعت در منطقه‌ی زمانی تو وجود ندارد (تغییر ساعت). ساعت دیگری بفرست." : "⚠️ That clock time does not exist in your timezone (DST change). Please send another time.";
      case "unsupported_recurrence":
        return lang === "fa" ? "⚠️ این نوع تکرار پشتیبانی نمی‌شود. تکرارهای ساده مثل «هر روز»، «هر هفته»، «هر ماه» کار می‌کنند." : "⚠️ That kind of recurrence is not supported. Simple ones like \"every day\", \"every week\", \"every month\" work.";
      default:
        return lang === "fa" ? "⚠️ نتوانستم آن را پردازش کنم." : "⚠️ I could not process that.";
    }
  }
  switch (parseResult.missing) {
    case "timezone":
      return lang === "fa"
        ? "🌍 اول منطقه‌ی زمانی‌ات را تنظیم کن:\n<code>/timezone Asia/Tehran</code>"
        : "🌍 Set your timezone first:\n<code>/timezone Asia/Tehran</code>";
    case "time":
      return lang === "fa" ? "🕐 چه ساعتی؟" : "🕐 What time?";
    case "date":
      return lang === "fa" ? "📅 چه روزی؟" : "📅 Which day?";
    case "datetime":
      return lang === "fa" ? "📅 چه روز و چه ساعتی؟" : "📅 Which day and what time?";
    case "title":
      return lang === "fa" ? "✏️ یادآوری برای چه کاری؟" : "✏️ What should I remind you about?";
    default:
      return lang === "fa" ? "متوجه نشدم. مثال: /remind فردا ساعت ۹ جلسه" : "I did not understand. Example: /remind tomorrow at 9 meeting";
  }
}

/**
 * Prompt shown when a 12-hour time is genuinely undecidable (`ساعت ۸` with no
 * صبح/شب and no 24-hour form). The options are the two readings, so the user
 * answers with one tap instead of retyping the whole sentence.
 */
export function ambiguityPrompt(ambiguity, lang) {
  if (!ambiguity) return lang === "fa" ? "🕐 منظورت کدام ساعت بود؟" : "🕐 Which time did you mean?";
  const opts = ambiguity.options || [];
  const list = opts.map(function (o) {
    return "• " + localDigits(pad2(o.hour), lang) + ":" + localDigits(pad2(o.minute), lang);
  }).join("\n");
  return lang === "fa"
    ? "🕐 «" + escapeHtml(ambiguity.text) + "» صبح است یا شب؟\n\n" + list
    : "🕐 Is \"" + escapeHtml(ambiguity.text) + "\" in the morning or evening?\n\n" + list;
}

/** Inline keyboard rows for an ambiguity prompt: one button per reading. */
export function ambiguityKeyboard(ambiguity) {
  const opts = (ambiguity && ambiguity.options) || [];
  const row = opts.slice(0, 2).map(function (o) {
    return { text: pad2(o.hour) + ":" + pad2(o.minute), callback_data: "rmd:pick:" + o.hour + ":" + o.minute };
  });
  return row.length ? { inline_keyboard: [row] } : null;
}

/** Timezone menu text. */
export function timezoneMessage(current, lang) {
  const head = current
    ? (lang === "fa" ? "🌍 منطقه‌ی زمانی فعلی: <code>" + escapeHtml(current) + "</code>" : "🌍 Current timezone: <code>" + escapeHtml(current) + "</code>")
    : (lang === "fa" ? "🌍 منطقه‌ی زمانی تنظیم نشده است." : "🌍 No timezone is set yet.");
  const body = lang === "fa"
    ? "برای تغییر: <code>/timezone Asia/Tehran</code>"
    : "To change it: <code>/timezone Asia/Tehran</code>";
  return head + "\n\n" + body;
}

/** Shared "help" fragment for the reminder commands. */
export function reminderHelpLines(isGroup, lang) {
  if (lang === "fa") {
    const out = ["<b>یادآورها</b>", "/remind — ساخت یادآور (زبان طبیعی)", "/reminders — فهرست یادآورها", "/reminder &lt;id&gt; — جزئیات یک یادآور", "/donereminder &lt;id&gt; — انجام‌شده", "/cancelreminder &lt;id&gt; — لغو", "/timezone — تنظیم منطقه‌ی زمانی"];
    if (isGroup) out.push("در گروه‌ها یادآورها خصوصی هستند؛ از پیوی استفاده کن.");
    return out;
  }
  const out = ["<b>Reminders</b>", "/remind — create with natural language", "/reminders — list", "/reminder &lt;id&gt; — details", "/donereminder &lt;id&gt; — mark done", "/cancelreminder &lt;id&gt; — cancel", "/timezone — set your timezone"];
  if (isGroup) out.push("Reminders are private; please use a private chat.");
  return out;
}
