// Deliver due personal schedules. Runs on the shared 5-minute Cron.
import { escapeHtml, now } from "../utils.js";
import { sendMessageReturn, sendRichMessageSafe } from "../telegram.js";
import {
  claimDueSchedules, settleScheduleDelivery, releaseScheduleForRetry,
  computeNextRunAt, defaultTemplate
} from "../db/schedules.js";

const PERMANENT = [400, 403];

function isPermanent(result) {
  if (!result) return false;
  if (PERMANENT.indexOf(result.error_code) !== -1) return true;
  return /bot was blocked|user is deactivated|chat not found/i.test(String(result.description || ""));
}

function resolveText(schedule, lang) {
  if (schedule.message_text && String(schedule.message_text).trim()) {
    return String(schedule.message_text).trim();
  }
  return defaultTemplate(schedule.kind, lang);
}

export async function deliverDueSchedules(env, nowSec) {
  const ts = Number.isFinite(nowSec) ? nowSec : now();
  const claimed = await claimDueSchedules(env, ts, 15);
  let sent = 0, failed = 0;
  for (let i = 0; i < claimed.length; i++) {
    const s = claimed[i];
    const lang = (s.timezone && s.timezone.indexOf("Tehran") !== -1) ? "fa" : "en";
    // Prefer stored user locale when available
    let userLang = lang;
    try {
      const u = await env.DB.prepare("SELECT locale, language_code FROM users WHERE telegram_id = ?").bind(s.telegram_id).first();
      if (u) {
        const code = (u.locale || u.language_code || "").toString().toLowerCase();
        userLang = code.indexOf("en") === 0 ? "en" : "fa";
      }
    } catch (err) {}

    const text = resolveText(s, userLang);
    const chatId = s.chat_id || s.telegram_id;
    let result;
    try {
      // Prefer Rich Message (markdown) with automatic classic fallback.
      result = await sendRichMessageSafe(env, chatId, text, { parse_mode: "HTML" });
    } catch (err) {
      result = { ok: false, description: err.message };
    }

    const next = computeNextRunAt(s.local_time, s.timezone, s.days_of_week, ts + 30);
    if (result && result.ok) {
      await settleScheduleDelivery(env, s.id, s.claim_token, next, "sent");
      sent++;
    } else if (isPermanent(result)) {
      // Disable on permanent failure so we do not loop forever.
      try {
        await env.DB.prepare(
          "UPDATE schedules SET enabled = 0, claim_token = NULL, claimed_at = NULL, last_status = ?, last_run_at = ?, updated_at = ? WHERE id = ?"
        ).bind("permanent_fail", ts, ts, s.id).run();
      } catch (err) {}
      failed++;
    } else {
      await releaseScheduleForRetry(env, s.id, s.claim_token);
      failed++;
    }
  }
  if (claimed.length) {
    console.log("schedules: claimed=" + claimed.length + " sent=" + sent + " failed=" + failed);
  }
  return { claimed: claimed.length, sent, failed };
}
