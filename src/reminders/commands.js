// Reminder command surface and the clarification state machine.
//
// This is the only place that turns a parsed request into a stored reminder, so
// the "never confirm before persistence" rule has exactly one implementation:
// nothing here sends a success message until `createReminder` returned
// `{ ok: true }`.
//
// Ownership: every read and write goes through an owner-scoped storage helper
// seeded with `userId` from the authenticated Telegram update. A reminder id
// arriving in a callback payload or a command argument is a lookup key only —
// `getReminderById(env, id, userId)` cannot return another user's row, so
// possessing an id never authorizes anything and a foreign id is
// indistinguishable from a missing one.
//
// Clarification state shares the `flow:<userId>` KV slot the setup wizards use,
// so a user can only ever have one pending question and the existing `/cancel`
// handling in the message pipeline clears it for free. It is written directly
// rather than through `setFlowState` because a clarification has its own TTL
// (`REMINDER_CLARIFY_TTL`) and must not be cut short by `FLOW_TTL`.
import {
  MAX_REMINDERS_PER_USER, MAX_REMINDER_TITLE, RATE_LIMIT_USER_PER_MIN,
  REMINDER_CLARIFY_TTL, REMINDER_LIST_PAGE, REMINDER_TZ_SUGGESTIONS
} from "../config.js";
import { checkRateLimit } from "../utils.js";
import { sendMessage, editMessage, buildInlineKeyboard, answerCallback } from "../telegram.js";
import {
  createReminder, getReminderById, listReminders, countReminders, updateReminder,
  cancelReminder, completeReminder, setUserTimezone, getUserTimezone,
  getUser, getFlowState, clearFlowState
} from "../db.js";
import {
  confirmationMessage, assumedNotice, listMessage, detailMessage, cancelledMessage,
  completedMessage, parseOutcomeMessage, ambiguityPrompt, ambiguityKeyboard, timezoneMessage
} from "./format.js";
import { parseReminder, detectLang, looksLikeReminderRequest } from "./parse.js";
import { normalizeDigits } from "./lexicon.js";
import { isValidTimeZone } from "./tz.js";

// `failed` is part of the visible list: a reminder that could not be delivered
// is exactly the row the user needs to see (and can then cancel and recreate).
const LIST_STATUSES = ["pending", "processing", "failed"];

// How many times a clarification may ask again before it gives up and tells the
// user to resend the whole request. Bounded so a stuck conversation cannot loop.
const MAX_FOLLOWUP_ROUNDS = 2;

const AM_WORDS = ["صبح", "بامداد", "am", "a.m"];
const PM_WORDS = ["شب", "عصر", "بعدازظهر", "بعد از ظهر", "شبانه", "pm", "p.m"];

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

/** Tiny bilingual string picker; keeps every message in one readable place. */
function t(lang, fa, en) {
  return lang === "fa" ? fa : en;
}

function notFoundText(lang) {
  return t(lang, "یادآور پیدا نشد.", "Reminder not found.");
}

/**
 * The language to answer in.
 *
 * The message text is the strongest signal (`detectLang`), because a user whose
 * Telegram client is set to English still writes to Nyra in Persian. Only when
 * there is no text at all (a button tap) does the stored `language_code` decide.
 */
export async function resolveReminderLang(env, userId, text) {
  const raw = String(text || "").trim();
  if (raw) return detectLang(raw);
  try {
    const user = await getUser(env, userId);
    const code = user && user.language_code ? String(user.language_code).slice(0, 2).toLowerCase() : "";
    if (code === "en") return "en";
  } catch (err) { /* fall through to the default */ }
  return "fa";
}

// --- Clarification state ---------------------------------------------------

async function armClarify(env, userId, state) {
  try {
    const payload = Object.assign({ flowType: "reminder_clarify" }, state);
    await env.KV.put("flow:" + userId, JSON.stringify(payload), { expirationTtl: REMINDER_CLARIFY_TTL });
  } catch (err) {
    console.error("armClarify failed:", err.message);
  }
}

function timezoneKeyboard() {
  const rows = [];
  for (let i = 0; i < REMINDER_TZ_SUGGESTIONS.length; i += 2) {
    rows.push(REMINDER_TZ_SUGGESTIONS.slice(i, i + 2).map(function (zone) {
      return { text: zone, callback_data: "rmd:tz:" + zone };
    }));
  }
  return buildInlineKeyboard(rows);
}

function meridiemFromText(text) {
  const s = String(text || "").toLowerCase();
  for (let i = 0; i < PM_WORDS.length; i++) if (s.indexOf(PM_WORDS[i]) !== -1) return "pm";
  for (let i = 0; i < AM_WORDS.length; i++) if (s.indexOf(AM_WORDS[i]) !== -1) return "am";
  return null;
}

function toHour24(hour, meridiem) {
  if (hour > 12) return hour;
  if (meridiem === "am") return hour === 12 ? 0 : hour;
  return hour === 12 ? 12 : hour + 12;
}

/**
 * Read a clock answer to "which time did you mean?".
 *
 * Returns `HH:MM` in 24-hour form, or `null` when the answer is still
 * undecidable — a bare "8" to a morning/evening question is the same ambiguity
 * again, so it is asked once more instead of being guessed.
 */
function clockFromReply(text, state) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const meridiem = meridiemFromText(raw);
  const digits = normalizeDigits(raw);
  const m = /(\d{1,2})\s*(?:[:.]\s*(\d{2}))?/.exec(digits);
  if (m) {
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    if (!Number.isFinite(hour) || minute > 59) return null;
    const padded = m[1].length === 2 && m[1][0] === "0";
    if (meridiem && hour >= 1 && hour <= 12) hour = toHour24(hour, meridiem);
    if (hour > 23) return null;
    if (!meridiem && !padded && hour >= 1 && hour <= 12) return null;
    return pad2(hour) + ":" + pad2(minute);
  }
  if (meridiem) {
    const options = (state && state.options) || [];
    const pick = meridiem === "am" ? options[0] : options[1];
    if (pick && Number.isFinite(pick.hour)) return pad2(pick.hour) + ":" + pad2(pick.minute || 0);
  }
  return null;
}

// --- Creation --------------------------------------------------------------

/**
 * Persist a resolved parse result and confirm it.
 *
 * The confirmation goes to `messageId` when there is one (the clarification
 * prompt is replaced by the result, so the chat is not littered with questions),
 * and falls back to a fresh message when editing is not possible.
 */
async function persistReminder(env, chatId, userId, result, lang, messageId) {
  const created = await createReminder(env, {
    telegramId: userId,
    chatId: chatId,
    title: result.title,
    description: result.description,
    startAt: result.atSeconds,
    nextRunAt: result.atSeconds,
    timezone: result.tz,
    recurrence: result.recurrence || null
  });
  if (!created || !created.ok) {
    const reason = created ? created.reason : "db_error";
    const text = reason === "quota"
      ? t(lang,
        "⚠️ سقف " + MAX_REMINDERS_PER_USER + " یادآور فعال پر شده است. اول یکی را لغو کن.",
        "⚠️ You have reached the limit of " + MAX_REMINDERS_PER_USER + " active reminders. Cancel one first.")
      : t(lang,
        "⚠️ ذخیره نشد — خطای پایگاه داده. چند لحظه بعد دوباره تلاش کن.",
        "⚠️ Could not save it — database error. Please try again in a moment.");
    await sendMessage(env, chatId, text, { parse_mode: "HTML" });
    return reason;
  }
  const body = confirmationMessage(created.reminder, lang);
  const notice = assumedNotice(result, lang);
  const text = notice ? notice + "\n\n" + body : body;
  const sent = await editMessage(env, chatId, messageId, text, null, "HTML");
  if (!sent || !sent.ok) await sendMessage(env, chatId, text, { parse_mode: "HTML" });
  return "created";
}

/**
 * Parse `text` and either persist it, ask a clarifying question, or report why
 * it could not be used.
 *
 * `followupRounds` counts how many times this conversation has already asked for
 * the missing date/time, so a request that can never be completed stops asking.
 */
async function attemptCreate(env, chatId, userId, text, lang, followupRounds, messageId) {
  const tz = await getUserTimezone(env, userId);
  if (!tz) {
    // Never guessed from the language: a wrong zone schedules a wrong instant.
    await sendMessage(env, chatId, parseOutcomeMessage({ missing: "timezone" }, lang),
      { parse_mode: "HTML", reply_markup: timezoneKeyboard() });
    return "no_timezone";
  }

  const result = parseReminder(text, { nowMs: Date.now(), timezone: tz, lang: lang });
  if (result.ok) return await persistReminder(env, chatId, userId, result, lang, messageId);

  if (result.ambiguous && result.ambiguous.length) {
    const ambiguity = result.ambiguous[0];
    await armClarify(env, userId, {
      mode: "meridiem", lang: lang, text: text,
      range: ambiguity.range || null, options: ambiguity.options || [], rounds: 0
    });
    await sendMessage(env, chatId, ambiguityPrompt(ambiguity, lang),
      { parse_mode: "HTML", reply_markup: ambiguityKeyboard(ambiguity) });
    return "ambiguous";
  }

  const rounds = Number.isFinite(followupRounds) ? followupRounds : 0;

  // Everything is known except what to call it: keep the resolved instant and
  // ask for a title, instead of throwing the parsed time away.
  if (result.missing === "title" && Number.isFinite(result.at) && !result.error) {
    await armClarify(env, userId, {
      mode: "title", lang: lang, tz: tz,
      atSeconds: Math.floor(result.at / 1000),
      recurrence: result.recurrence || null
    });
    await sendMessage(env, chatId, parseOutcomeMessage(result, lang), { parse_mode: "HTML" });
    return "missing_title";
  }

  const fixable = result.missing === "time" || result.missing === "date" || result.missing === "datetime";
  if (fixable && !result.error && rounds < MAX_FOLLOWUP_ROUNDS) {
    await armClarify(env, userId, { mode: "followup", lang: lang, text: text, rounds: rounds + 1 });
    await sendMessage(env, chatId, parseOutcomeMessage(result, lang), { parse_mode: "HTML" });
    return "missing_" + result.missing;
  }

  const hint = t(lang,
    "برای شروع دوباره کامل بنویس:\n<code>/remind فردا ساعت ۹ جلسه</code>",
    "To start over, write it in full:\n<code>/remind tomorrow at 9 meeting</code>");
  const text2 = parseOutcomeMessage(result, lang) + (fixable ? "\n\n" + hint : "");
  await sendMessage(env, chatId, text2, { parse_mode: "HTML" });
  return result.error || result.missing || "invalid";
}

// --- Commands --------------------------------------------------------------

/** `/remind <natural language>` */
export async function handleRemindCommand(env, chatId, userId, args, lang) {
  const raw = String(args || "").trim();
  if (!raw) {
    await sendMessage(env, chatId, t(lang,
      "مثال:\n<code>/remind فردا ساعت ۹ جلسه</code>\n<code>/remind هر دوشنبه ساعت ۱۰ ورزش</code>\n<code>/remind ۲ ساعت دیگه چای</code>",
      "Examples:\n<code>/remind tomorrow at 9 meeting</code>\n<code>/remind every Monday at 10 gym</code>\n<code>/remind in 2 hours tea</code>"),
      { parse_mode: "HTML" });
    return "usage";
  }
  const allowed = await checkRateLimit(env, "remind:" + userId, RATE_LIMIT_USER_PER_MIN, 60);
  if (!allowed) {
    await sendMessage(env, chatId, t(lang, "کمی آرام‌تر! چند لحظه بعد دوباره تلاش کن.", "Slow down a little, then try again."));
    return "rate_limited";
  }
  return await attemptCreate(env, chatId, userId, raw, lang, 0, null);
}

/** `/reminders [cursorId]` */
export async function handleRemindersCommand(env, chatId, userId, args, lang) {
  const cursor = parseInt(String(args || "").trim(), 10);
  const options = { limit: REMINDER_LIST_PAGE, statuses: LIST_STATUSES };
  if (Number.isInteger(cursor) && cursor > 0) options.beforeId = cursor;
  const items = await listReminders(env, userId, options);
  const total = await countReminders(env, userId, LIST_STATUSES);
  const hasMore = items.length === REMINDER_LIST_PAGE && total > items.length;
  await sendMessage(env, chatId, listMessage(items, lang, total, hasMore), { parse_mode: "HTML" });
  return "listed";
}

/** Parse an id argument. Rejects anything that is not a positive integer. */
function readId(args) {
  const raw = String(args || "").trim().split(/\s+/)[0];
  if (!/^\d+$/.test(normalizeDigits(raw))) return null;
  const id = parseInt(normalizeDigits(raw), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** `/reminder <id>` */
export async function handleReminderDetailCommand(env, chatId, userId, args, lang) {
  const id = readId(args);
  if (id === null) {
    await sendMessage(env, chatId, t(lang, "استفاده: <code>/reminder &lt;id&gt;</code>", "Usage: <code>/reminder &lt;id&gt;</code>"), { parse_mode: "HTML" });
    return "usage";
  }
  const reminder = await getReminderById(env, id, userId);
  if (!reminder) {
    await sendMessage(env, chatId, notFoundText(lang), { parse_mode: "HTML" });
    return "not_found";
  }
  await sendMessage(env, chatId, detailMessage(reminder, lang), { parse_mode: "HTML" });
  return "shown";
}

/**
 * `/editreminder <id> <natural language>`
 *
 * Only a live reminder can be edited: a delivered or failed row would keep its
 * terminal status, so "editing" it would look like a success while changing
 * nothing that will ever fire again. Those are cancelled and recreated instead.
 */
export async function handleEditReminderCommand(env, chatId, userId, args, lang) {
  const raw = String(args || "").trim();
  const m = /^(\d+)\s+([\s\S]+)$/.exec(normalizeDigits(raw));
  if (!m || !/([A-Za-z\u0600-\u06FF])/.test(m[2])) {
    await sendMessage(env, chatId, t(lang, "استفاده: <code>/editreminder &lt;id&gt; فردا ساعت ۱۰ جلسه</code>", "Usage: <code>/editreminder &lt;id&gt; tomorrow at 10 meeting</code>"), { parse_mode: "HTML" });
    return "usage";
  }
  const id = parseInt(m[1], 10);
  const existing = await getReminderById(env, id, userId);
  if (!existing) {
    await sendMessage(env, chatId, notFoundText(lang), { parse_mode: "HTML" });
    return "not_found";
  }
  if (existing.status !== "pending" && existing.status !== "processing") {
    await sendMessage(env, chatId, t(lang,
      "این یادآور دیگر فعال نیست، پس ویرایشش فایده‌ای ندارد. یک یادآور تازه بساز.",
      "That reminder is no longer active, so editing it would change nothing. Please create a new one."),
      { parse_mode: "HTML" });
    return "inactive";
  }
  const tz = existing.timezone || await getUserTimezone(env, userId);
  const result = parseReminder(m[2], { nowMs: Date.now(), timezone: tz, lang: lang });
  if (!result.ok) {
    await sendMessage(env, chatId, parseOutcomeMessage(result, lang), { parse_mode: "HTML" });
    return result.error || result.missing || "invalid";
  }
  const updated = await updateReminder(env, id, userId, {
    title: result.title,
    description: result.description,
    startAt: result.atSeconds,
    nextRunAt: result.atSeconds,
    recurrence: result.recurrence || null
  });
  if (!updated) {
    await sendMessage(env, chatId, t(lang, "⚠️ ویرایش ذخیره نشد. دوباره تلاش کن.", "⚠️ The edit could not be saved. Please try again."), { parse_mode: "HTML" });
    return "db_error";
  }
  await sendMessage(env, chatId, detailMessage(updated, lang), { parse_mode: "HTML" });
  return "edited";
}

/** `/cancelreminder <id>` */
export async function handleCancelReminderCommand(env, chatId, userId, args, lang) {
  const id = readId(args);
  if (id === null) {
    await sendMessage(env, chatId, t(lang, "استفاده: <code>/cancelreminder &lt;id&gt;</code>", "Usage: <code>/cancelreminder &lt;id&gt;</code>"), { parse_mode: "HTML" });
    return "usage";
  }
  const existing = await getReminderById(env, id, userId);
  if (!existing) {
    await sendMessage(env, chatId, notFoundText(lang), { parse_mode: "HTML" });
    return "not_found";
  }
  const ok = await cancelReminder(env, id, userId);
  if (!ok) {
    await sendMessage(env, chatId, t(lang, "این یادآور دیگر فعال نیست.", "That reminder is no longer active."), { parse_mode: "HTML" });
    return "inactive";
  }
  await sendMessage(env, chatId, cancelledMessage(existing, lang), { parse_mode: "HTML" });
  return "cancelled";
}

/** `/donereminder <id>` */
export async function handleDoneReminderCommand(env, chatId, userId, args, lang) {
  const id = readId(args);
  if (id === null) {
    await sendMessage(env, chatId, t(lang, "استفاده: <code>/donereminder &lt;id&gt;</code>", "Usage: <code>/donereminder &lt;id&gt;</code>"), { parse_mode: "HTML" });
    return "usage";
  }
  const existing = await getReminderById(env, id, userId);
  if (!existing) {
    await sendMessage(env, chatId, notFoundText(lang), { parse_mode: "HTML" });
    return "not_found";
  }
  const ok = await completeReminder(env, id, userId);
  if (!ok) {
    await sendMessage(env, chatId, t(lang, "این یادآور دیگر فعال نیست.", "That reminder is no longer active."), { parse_mode: "HTML" });
    return "inactive";
  }
  await sendMessage(env, chatId, completedMessage(existing, lang), { parse_mode: "HTML" });
  return "done";
}

/** `/timezone [IANA zone]` */
export async function handleTimezoneCommand(env, chatId, userId, args, lang) {
  const value = String(args || "").trim();
  if (!value) {
    const current = await getUserTimezone(env, userId);
    await sendMessage(env, chatId, timezoneMessage(current, lang), { parse_mode: "HTML", reply_markup: timezoneKeyboard() });
    return "shown";
  }
  if (!isValidTimeZone(value)) {
    await sendMessage(env, chatId,
      t(lang, "⚠️ این منطقه‌ی زمانی معتبر نیست. از نام IANA استفاده کن، مثل <code>Asia/Tehran</code>.", "⚠️ That is not a valid timezone. Use an IANA name like <code>Asia/Tehran</code>."),
      { parse_mode: "HTML", reply_markup: timezoneKeyboard() });
    return "invalid";
  }
  const ok = await setUserTimezone(env, userId, value);
  if (!ok) {
    await sendMessage(env, chatId, t(lang, "⚠️ ذخیره نشد. اول /start را بزن و بعد دوباره تلاش کن.", "⚠️ Could not save it. Send /start first, then try again."), { parse_mode: "HTML" });
    return "db_error";
  }
  await sendMessage(env, chatId, timezoneMessage(value, lang), { parse_mode: "HTML" });
  return "saved";
}

// --- Natural-language intent ----------------------------------------------

/**
 * Detect a natural-language reminder request in a private chat and handle it.
 *
 * Gated on an explicit reminder cue, so ordinary conversation ("فردا ساعت ۵
 * جلسه دارم") still reaches the AI pipeline untouched and no message pays for a
 * classification round trip. When the per-user budget is exhausted the function
 * returns `false` and the normal pipeline answers — a reminder feature must
 * never make Nyra stop replying.
 */
export async function maybeHandleReminderIntent(env, message, from, chat) {
  const text = (message.text || "").trim();
  if (!text || !looksLikeReminderRequest(text)) return false;
  const allowed = await checkRateLimit(env, "remindnl:" + from.id, RATE_LIMIT_USER_PER_MIN, 60);
  if (!allowed) return false;
  const lang = await resolveReminderLang(env, from.id, text);
  await attemptCreate(env, chat.id, from.id, text, lang, 0, null);
  return true;
}

/**
 * Continue a pending clarification. Called from the message pipeline's private
 * flow-state block, which has already handled `/cancel` and any slash command.
 */
export async function handleReminderClarification(env, message, from, chat, flowState) {
  const userId = from.id;
  const chatId = chat.id;
  const lang = flowState.lang === "en" ? "en" : "fa";
  const text = (message.text || "").trim();
  if (!text) return true;

  if (flowState.mode === "meridiem") {
    const clock = clockFromReply(text, flowState);
    if (!clock) {
      const rounds = (flowState.rounds || 0) + 1;
      if (rounds >= MAX_FOLLOWUP_ROUNDS) {
        await clearFlowState(env, userId);
        await sendMessage(env, chatId, t(lang,
          "متوجه نشدم. کل درخواست را با ساعت دقیق بفرست:\n<code>/remind فردا ساعت ۲۰ جلسه</code>",
          "I did not catch that. Send the whole request with an exact time:\n<code>/remind tomorrow at 20:00 meeting</code>"),
          { parse_mode: "HTML" });
        return true;
      }
      flowState.rounds = rounds;
      await armClarify(env, userId, flowState);
      await sendMessage(env, chatId, t(lang,
        "ساعت را با صبح/شب یا در قالب ۲۴ ساعتی بنویس. مثلاً <code>۲۰:۰۰</code> یا <code>۸ شب</code>.",
        "Write the time with am/pm or as 24-hour, e.g. <code>20:00</code> or <code>8 pm</code>."),
        { parse_mode: "HTML" });
      return true;
    }
    const range = flowState.range;
    const splittable = range && Number.isInteger(range.start) && Number.isInteger(range.end) && range.end > range.start;
    const withClock = splittable
      ? String(flowState.text).slice(0, range.start) + clock + String(flowState.text).slice(range.end)
      : String(flowState.text || "") + " " + clock;
    await clearFlowState(env, userId);
    await attemptCreate(env, chatId, userId, withClock, lang, 0, null);
    return true;
  }

  if (flowState.mode === "title") {
    const title = text.replace(/\s{2,}/g, " ").trim().slice(0, MAX_REMINDER_TITLE);
    await clearFlowState(env, userId);
    if (!title) {
      await sendMessage(env, chatId, t(lang, "یک عنوان کوتاه بفرست.", "Send a short title."));
      return true;
    }
    await persistReminder(env, chatId, userId, {
      title: title,
      description: null,
      atSeconds: flowState.atSeconds,
      recurrence: flowState.recurrence || null,
      tz: flowState.tz,
      assumedDate: null,
      dstAmbiguous: false
    }, lang, null);
    return true;
  }

  // Missing date/time: the reply completes the original sentence. A reply that
  // is already a complete request on its own wins, so a fresh reminder typed
  // while a question was pending is not swallowed by the pending one.
  const tz = await getUserTimezone(env, userId);
  if (tz) {
    const solo = parseReminder(text, { nowMs: Date.now(), timezone: tz, lang: lang });
    if (solo.ok) {
      await clearFlowState(env, userId);
      await persistReminder(env, chatId, userId, solo, lang, null);
      return true;
    }
  }
  const rounds = flowState.rounds || 0;
  const combined = flowState.text ? flowState.text + " " + text : text;
  await clearFlowState(env, userId);
  await attemptCreate(env, chatId, userId, combined, lang, rounds, null);
  return true;
}

// --- Callback surface (`rmd:*`) -------------------------------------------

/**
 * Button taps for the reminder surface. The dispatcher has already applied the
 * shared per-user callback rate limit; everything here is owner-scoped again
 * before it touches a row.
 */
export async function handleReminderCallback(env, query, parts) {
  const userId = query.from.id;
  const chatId = query.message ? query.message.chat.id : query.from.id;
  const messageId = query.message ? query.message.message_id : null;
  const action = parts[1];
  let lang = await resolveReminderLang(env, userId, "");

  if (action === "pick") {
    const hour = parseInt(parts[2], 10);
    const minute = parseInt(parts[3], 10);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      await answerCallback(env, query.id, "");
      await editMessage(env, chatId, messageId, t(lang, "گزینه نامعتبر.", "Invalid option."), null, "HTML");
      return true;
    }
    const state = await getFlowState(env, userId);
    await answerCallback(env, query.id, pad2(hour) + ":" + pad2(minute));
    if (!state || state.flowType !== "reminder_clarify" || state.mode !== "meridiem") {
      // Never clear a state that is not ours: a stale button must not cancel a
      // setup wizard the user is in the middle of.
      await editMessage(env, chatId, messageId, t(lang, "این پرسش منقضی شده. درخواست را دوباره بفرست.", "That question expired. Please send the request again."), null, "HTML");
      return true;
    }
    lang = state.lang === "en" ? "en" : "fa";
    const clock = pad2(hour) + ":" + pad2(minute);
    const range = state.range;
    const splittable = range && Number.isInteger(range.start) && Number.isInteger(range.end) && range.end > range.start;
    const withClock = splittable
      ? String(state.text).slice(0, range.start) + clock + String(state.text).slice(range.end)
      : String(state.text || "") + " " + clock;
    await clearFlowState(env, userId);
    await attemptCreate(env, chatId, userId, withClock, lang, 0, messageId);
    return true;
  }

  if (action === "tz") {
    // The zone came from a button we rendered, but validation is still done
    // here: callback_data is client-supplied input like any other.
    const zone = parts.slice(2).join(":");
    if (!isValidTimeZone(zone)) {
      await answerCallback(env, query.id, "");
      return true;
    }
    await setUserTimezone(env, userId, zone);
    await answerCallback(env, query.id, zone);
    await editMessage(env, chatId, messageId,
      timezoneMessage(zone, lang) + "\n\n" + t(lang,
        "حالا یادآور را بفرست: <code>/remind فردا ساعت ۹ جلسه</code>",
        "Now send the reminder: <code>/remind tomorrow at 9 meeting</code>"),
      null, "HTML");
    return true;
  }

  if (action === "cancel" || action === "done") {
    const id = parseInt(parts[2], 10);
    if (!Number.isInteger(id) || id <= 0) {
      await answerCallback(env, query.id, "");
      return true;
    }
    const existing = await getReminderById(env, id, userId);
    await answerCallback(env, query.id, "");
    if (!existing) {
      await editMessage(env, chatId, messageId, notFoundText(lang), null, "HTML");
      return true;
    }
    lang = await resolveReminderLang(env, userId, String(existing.title || ""));
    const ok = action === "done" ? await completeReminder(env, id, userId) : await cancelReminder(env, id, userId);
    if (!ok) {
      await editMessage(env, chatId, messageId, t(lang, "این یادآور دیگر فعال نیست.", "That reminder is no longer active."), null, "HTML");
      return true;
    }
    await editMessage(env, chatId, messageId, action === "done" ? completedMessage(existing, lang) : cancelledMessage(existing, lang), null, "HTML");
    return true;
  }

  await answerCallback(env, query.id, "");
  return true;
}
