// Reminder delivery: the cron-driven worker side of the subsystem.
//
// Shape of one tick:
//
//   1. return reminders whose delivery lease expired to `pending` (crash recovery)
//   2. atomically claim a bounded batch of due reminders
//   3. for each claimed reminder: send, then settle (advance or finish)
//
// Rules this module exists to enforce:
//
//   * Delivery never depends on an LLM call. A reminder fires on its stored
//     instant even if every AI provider is down.
//   * No Telegram send happens while a database transaction is open. The claim
//     is committed by `claimDueReminders`, then the send happens, then a separate
//     settle statement runs. Nothing holds a D1 transaction across a network
//     round trip.
//   * The only thing that makes a delivery happen exactly once is the claim
//     token plus the conditional settle statement. Telegram's `sendMessage` has
//     NO idempotency key, so there is an irreducible window: if the Worker dies
//     after Telegram accepted the message but before the settle writes, the
//     lease expires and the next tick sends it again. That window is small but
//     real, and it is documented in the README rather than papered over.
//   * A recurring reminder's next instant is always recomputed from its anchor,
//     so a reminder that could not fire for a while skips the missed occurrences
//     instead of being dragged off its schedule.
import {
  REMINDER_BATCH_SIZE, REMINDER_CLAIM_LEASE_S, REMINDER_MAX_ATTEMPTS, REMINDER_RETRY_BACKOFF_S
} from "../config.js";
import { now, escapeHtml } from "../utils.js";
import { sendMessageReturn } from "../telegram.js";
import {
  claimDueReminders, recoverStaleClaims, recordDeliveryAttempt,
  releaseReminderForRetry, failReminderPermanently, settleReminderDelivery
} from "../db.js";
import { detectLang } from "./parse.js";
import { dueMessage } from "./format.js";
import { occurrenceAt } from "./schedule.js";

/**
 * Telegram error codes that a retry cannot fix.
 *
 * 403 means the user blocked the bot or deleted the chat — retrying only burns
 * the retry budget. 400 covers "chat not found", "message is too long" and
 * similar permanent rejections. 429 is deliberately absent: `tg()` already
 * honours `retry_after` internally, so if a 429 reaches us the budget is spent
 * and the next cron tick should try instead.
 */
const PERMANENT_ERROR_CODES = [400, 403];

function isPermanentFailure(result) {
  if (!result) return false;
  if (PERMANENT_ERROR_CODES.indexOf(result.error_code) !== -1) return true;
  const description = String(result.description || "");
  // Telegram sometimes reports these without a useful numeric code.
  return /bot was blocked|user is deactivated|chat not found|bot can't initiate/i.test(description);
}

/**
 * Fixed-length recurrences, in milliseconds, used only to *shortcut* a long
 * missed window. Minute/hour are exact everywhere; day/week are approximate
 * across a DST change, which is fine because the shortcut deliberately
 * undershoots and the anchored walk below lands on the exact instant.
 *
 * Month and year are absent on purpose: 5000 monthly steps is four centuries,
 * so those never need the shortcut.
 */
const FIXED_BUCKET_MS = { minute: 60000, hour: 3600000, day: 86400000, week: 604800000 };

/**
 * The next instant a recurring reminder should fire, recomputed from its anchor.
 *
 * `deliveredSoFar` is the number of occurrences already delivered, which is also
 * the zero-based index of the occurrence to compute next. Occurrences that fell
 * inside a missed window are skipped — the reminder jumps forward rather than
 * firing a backlog — but the schedule itself never shifts, because every step is
 * measured from the original anchor.
 *
 * Returns `null` when the recurrence cannot be advanced (corrupt stored value),
 * which the caller treats as "stop recurring" rather than "retry forever".
 */
export function advanceOccurrence(anchorSeconds, timezone, recurrence, deliveredSoFar, nowSeconds) {
  const anchorMs = anchorSeconds * 1000;
  const nowMs = nowSeconds * 1000;
  let index = Number.isFinite(deliveredSoFar) && deliveredSoFar >= 0 ? deliveredSoFar : 0;
  let next = occurrenceAt(anchorMs, timezone, recurrence, index);
  if (next === null) return null;

  // A `*/5 minute` reminder that sat undelivered for a month is hundreds of
  // thousands of occurrences away. Walking them one at a time would either spin
  // or give up and deliver a stale instant, so for fixed-length buckets jump
  // most of the distance first. Undershoot by one step; the loop finishes the
  // job and always yields an anchored instant.
  const step = FIXED_BUCKET_MS[recurrence && recurrence.bucket];
  if (step && next <= nowMs) {
    const interval = Math.max(1, recurrence.interval || 1);
    const jump = Math.floor((nowMs - next) / (step * interval)) - 1;
    if (jump > 0) {
      index += jump;
      next = occurrenceAt(anchorMs, timezone, recurrence, index);
      if (next === null) return null;
    }
  }

  let guard = 0;
  const MAX_SKIPPED = 5000;
  while (next <= nowMs && guard < MAX_SKIPPED) {
    index += 1;
    next = occurrenceAt(anchorMs, timezone, recurrence, index);
    if (next === null) return null;
    guard++;
  }
  return { nextRunAt: Math.floor(next / 1000), occurrence: index + 1 };
}

/** Retry delay for attempt number `attempts` (1-based), capped at the last entry. */
function retryDelaySeconds(attempts) {
  const table = REMINDER_RETRY_BACKOFF_S;
  const idx = Math.min(Math.max(attempts - 1, 0), table.length - 1);
  return table[idx];
}

/**
 * Resolve the delivery language for a whole batch in one query.
 *
 * Doing this per reminder would be an N+1 against D1 for no reason, and using
 * the worker's own guess would show a Persian user English text. Falls back to
 * per-reminder text detection when the lookup fails, so a D1 hiccup cannot stop
 * delivery.
 */
async function resolveLanguages(env, reminders) {
  const map = new Map();
  const ids = [];
  for (let i = 0; i < reminders.length; i++) {
    const id = reminders[i].telegramId;
    if (Number.isFinite(id) && ids.indexOf(id) === -1) ids.push(id);
  }
  if (ids.length) {
    const placeholders = ids.map(function () { return "?"; }).join(",");
    try {
      const result = await env.DB
        .prepare("SELECT telegram_id, language_code FROM users WHERE telegram_id IN (" + placeholders + ")")
        .bind(...ids).all();
      for (const row of (result.results || [])) {
        if (row.language_code) map.set(row.telegram_id, String(row.language_code).slice(0, 2).toLowerCase());
      }
    } catch (err) {
      console.error("reminder language lookup failed:", err.message);
    }
  }
  const out = new Map();
  for (let i = 0; i < reminders.length; i++) {
    const r = reminders[i];
    const code = map.get(r.telegramId);
    out.set(r.id, code === "en" || code === "fa" ? code : detectLang(String(r.title || "") + " " + String(r.description || "")));
  }
  return out;
}

/**
 * Best-effort notice that a reminder will never be delivered. Never throws.
 *
 * Skipped when the failure itself was "I cannot message this chat" (403 /
 * blocked / chat not found) — sending a notice there would fail for the same
 * reason, and retrying it on every tick would be pointless traffic.
 */
async function notifyPermanentFailure(env, reminder, lang, failure) {
  const unreachable = failure && (
    failure.error_code === 403 ||
    /bot was blocked|user is deactivated|chat not found|bot can't initiate/i.test(String(failure.description || ""))
  );
  if (unreachable) return;
  const chatId = Number.isFinite(reminder.chatId) ? reminder.chatId : reminder.telegramId;
  const label = escapeHtml(reminder.title);
  const text = lang === "fa"
    ? "⚠️ یک یادآور ارسال نشد و غیرفعال شد:\n\n<b>" + label + "</b>\n\nاز <code>/reminders</code> می‌توانی ببینی‌اش."
    : "⚠️ One reminder could not be delivered and was disabled:\n\n<b>" + label + "</b>\n\nSee it in <code>/reminders</code>.";
  try { await sendMessageReturn(env, chatId, text, { parse_mode: "HTML" }); } catch (err) { /* best effort */ }
}

/**
 * Deliver one already-claimed reminder.
 *
 * Returns a short outcome string for logging/testing; never throws.
 */
export async function deliverOne(env, reminder, lang, nowSec) {
  const chatId = Number.isFinite(reminder.chatId) ? reminder.chatId : reminder.telegramId;
  let result;
  try {
    result = await sendMessageReturn(env, chatId, dueMessage(reminder, lang), { parse_mode: "HTML" });
  } catch (err) {
    result = { ok: false, description: err.message };
  }

  const attempts = (reminder.attempts || 0) + 1;

  if (result && result.ok) {
    await recordDeliveryAttempt(env, reminder.id, attempts, "sent", null);
    if (reminder.recurrence) {
      const next = advanceOccurrence(reminder.startAt, reminder.timezone, reminder.recurrence, reminder.occurrence || 0, nowSec);
      if (next) {
        await settleReminderDelivery(env, reminder.id, reminder.claimToken, next);
        return "sent_recurring";
      }
      // The stored recurrence cannot be advanced. Finish the series instead of
      // retrying an instant that can never move.
      await settleReminderDelivery(env, reminder.id, reminder.claimToken, null);
      await recordDeliveryAttempt(env, reminder.id, attempts, "recurrence_ended", "unable to advance recurrence");
      return "sent_recurrence_ended";
    }
    await settleReminderDelivery(env, reminder.id, reminder.claimToken, null);
    return "sent";
  }

  const errorText = (result && (result.description || ("HTTP " + result.error_code))) || "unknown error";
  const permanent = isPermanentFailure(result) || attempts >= REMINDER_MAX_ATTEMPTS;
  await recordDeliveryAttempt(env, reminder.id, attempts, permanent ? "failed" : "retry", errorText);

  if (permanent) {
    await failReminderPermanently(env, reminder.id, reminder.claimToken, errorText, attempts);
    await notifyPermanentFailure(env, reminder, lang, result);
    return "failed";
  }

  const delay = retryDelaySeconds(attempts);
  await releaseReminderForRetry(env, reminder.id, reminder.claimToken, errorText, nowSec + delay, attempts);
  return "retry";
}

/**
 * One delivery pass. Called from the scheduled handler with the cron's `now`.
 *
 * Bounded by REMINDER_BATCH_SIZE so a backlog cannot exceed the Worker's CPU
 * budget in a single invocation; whatever is left is picked up by the next tick.
 * Sequential, not parallel, so Telegram's per-chat rate limit is respected and
 * the memory ceiling stays flat.
 */
export async function deliverDueReminders(env, nowSec) {
  const t = Number.isFinite(nowSec) ? nowSec : now();
  let recovered = 0;
  try {
    recovered = await recoverStaleClaims(env, t, REMINDER_CLAIM_LEASE_S);
  } catch (err) {
    console.error("reminder stale-claim recovery failed:", err.message);
  }

  let claimed;
  try {
    claimed = await claimDueReminders(env, t, REMINDER_BATCH_SIZE);
  } catch (err) {
    // Let this propagate: a failing claim means nothing was delivered and the
    // scheduled handler should record it rather than report a healthy tick.
    console.error("reminder claim failed:", err.message);
    throw err;
  }
  if (!claimed.length) return { recovered: recovered, claimed: 0, sent: 0, retried: 0, failed: 0 };

  const langs = await resolveLanguages(env, claimed);
  let sent = 0;
  let retried = 0;
  let failed = 0;
  for (let i = 0; i < claimed.length; i++) {
    const reminder = claimed[i];
    const lang = langs.get(reminder.id) || "fa";
    let outcome;
    try {
      outcome = await deliverOne(env, reminder, lang, t);
    } catch (err) {
      // A bug here must not abandon the rest of the batch: the claim lease will
      // return this row to `pending` on the next tick.
      console.error("reminder delivery crashed for id " + reminder.id + ":", err.message);
      outcome = "retry";
    }
    if (outcome === "sent" || outcome === "sent_recurring" || outcome === "sent_recurrence_ended") sent++;
    else if (outcome === "failed") failed++;
    else retried++;
  }
  return { recovered: recovered, claimed: claimed.length, sent: sent, retried: retried, failed: failed };
}
