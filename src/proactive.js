// Proactive inactivity check-ins.
//
// Disabled by default. A user must explicitly enable it. Exactly one check-in
// is sent per inactivity episode (keyed by last_inbound_at). A new episode
// begins only after a fresh inbound private message clears proactive_episode_key.
//
// Delivery precision follows the shared 5-minute Cron trigger — not second-level.
// Quiet hours are evaluated in the user's IANA timezone when available.

import { now, escapeHtml } from "./utils.js";
import { sendMessageReturn } from "./telegram.js";
import { isValidTimeZone } from "./reminders/tz.js";

const PROACTIVE_BATCH = 20;
const TEMPLATE_FA = [
  "هی! امروز خبری ازت نشد. امیدوارم حالت خوب باشه ☕",
  "سلام! فقط سر زدم ببینم اوضاع چطوره.",
  "نبودی! هر وقت خواستی، اینجام."
];
const TEMPLATE_EN = [
  "Hey — haven't heard from you today. Hope you're doing well ☕",
  "Just checking in. No pressure.",
  "Missed you around here. Whenever you're back, I'm here."
];

function episodeKey(lastInboundAt) {
  return "ep:" + String(lastInboundAt || 0);
}

function pickTemplate(lang, seed) {
  const list = lang === "en" ? TEMPLATE_EN : TEMPLATE_FA;
  const idx = Math.abs(Number(seed) || 0) % list.length;
  return list[idx];
}

/**
 * True when local wall-clock hour is inside the user's quiet window.
 * quiet_start / quiet_end are hours 0–23; wrap-around (e.g. 22→7) is supported.
 */
function inQuietHours(timezone, quietStart, quietEnd, nowSec) {
  if (quietStart == null || quietEnd == null) return false;
  if (!Number.isInteger(quietStart) || !Number.isInteger(quietEnd)) return false;
  if (quietStart < 0 || quietStart > 23 || quietEnd < 0 || quietEnd > 23) return false;
  if (quietStart === quietEnd) return false;
  let hour;
  try {
    const tz = timezone && isValidTimeZone(timezone) ? timezone : "UTC";
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false });
    hour = parseInt(fmt.format(new Date(nowSec * 1000)), 10);
  } catch (err) {
    return false;
  }
  if (!Number.isFinite(hour)) return false;
  if (quietStart < quietEnd) return hour >= quietStart && hour < quietEnd;
  return hour >= quietStart || hour < quietEnd;
}

/**
 * Select eligible users and send at most one template check-in per episode.
 * Bounded batch. Permanent Telegram failures mark the episode settled so we
 * do not retry forever against blocked users.
 */
export async function deliverProactiveCheckins(env, nowSec) {
  const ts = Number.isFinite(nowSec) ? nowSec : now();
  let rows;
  try {
    // Eligible: enabled, has inbound activity, threshold elapsed, and either
    // never checked in for this episode or episode key does not match current.
    const res = await env.DB.prepare(
      "SELECT telegram_id, last_inbound_at, proactive_threshold_hours, proactive_quiet_start, " +
      "proactive_quiet_end, proactive_episode_key, timezone, locale, language_code " +
      "FROM users WHERE proactive_enabled = 1 AND last_inbound_at IS NOT NULL " +
      "AND (last_inbound_at + (COALESCE(proactive_threshold_hours, 24) * 3600)) <= ? " +
      "AND (proactive_episode_key IS NULL OR proactive_episode_key != ('ep:' || CAST(last_inbound_at AS TEXT))) " +
      "AND telegram_id NOT IN (SELECT telegram_id FROM blocked_users) " +
      "ORDER BY last_inbound_at ASC LIMIT ?"
    ).bind(ts, PROACTIVE_BATCH).all();
    rows = res.results || [];
  } catch (err) {
    console.error("proactive select failed:", err.message);
    return { scanned: 0, sent: 0, skipped: 0, failed: 0 };
  }

  let sent = 0, skipped = 0, failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const u = rows[i];
    const key = episodeKey(u.last_inbound_at);
    if (inQuietHours(u.timezone, u.proactive_quiet_start, u.proactive_quiet_end, ts)) {
      skipped++;
      continue;
    }
    const lang = (u.locale || u.language_code || "fa").toString().toLowerCase().startsWith("en") ? "en" : "fa";
    const text = pickTemplate(lang, u.telegram_id + (u.last_inbound_at || 0));

    // Claim the episode before the network call so concurrent cron ticks do not
    // double-send. If Telegram later fails permanently we keep the claim.
    try {
      const claim = await env.DB.prepare(
        "UPDATE users SET proactive_episode_key = ?, proactive_last_sent_at = ?, updated_at = ? " +
        "WHERE telegram_id = ? AND (proactive_episode_key IS NULL OR proactive_episode_key != ?)"
      ).bind(key, ts, ts, u.telegram_id, key).run();
      if (!claim.meta || claim.meta.changes === 0) {
        skipped++;
        continue;
      }
    } catch (err) {
      console.error("proactive claim failed:", err.message);
      failed++;
      continue;
    }

    let result;
    try {
      result = await sendMessageReturn(env, u.telegram_id, escapeHtml(text), { parse_mode: "HTML" });
    } catch (err) {
      result = { ok: false, description: err.message };
    }

    const ok = result && result.ok;
    const permanent = !ok && result && (result.error_code === 403 || result.error_code === 400 ||
      /bot was blocked|user is deactivated|chat not found/i.test(String(result.description || "")));

    try {
      await env.DB.prepare(
        "INSERT INTO proactive_delivery_attempts (telegram_id, episode_key, attempt, status, error, created_at) VALUES (?, ?, 1, ?, ?, ?)"
      ).bind(u.telegram_id, key, ok ? "sent" : (permanent ? "permanent_fail" : "fail"),
        ok ? null : String(result && result.description || "unknown").slice(0, 300), ts).run();
    } catch (err) { /* best-effort audit */ }

    if (ok) {
      sent++;
    } else if (permanent) {
      // Episode stays claimed — do not retry blocked users.
      failed++;
    } else {
      // Temporary failure: release claim so the next cron tick can retry.
      try {
        await env.DB.prepare(
          "UPDATE users SET proactive_episode_key = NULL, updated_at = ? WHERE telegram_id = ? AND proactive_episode_key = ?"
        ).bind(ts, u.telegram_id, key).run();
      } catch (err) {}
      failed++;
    }
  }

  if (rows.length > 0) {
    console.log("proactive: scanned=" + rows.length + " sent=" + sent + " skipped=" + skipped + " failed=" + failed);
  }
  return { scanned: rows.length, sent, skipped, failed };
}
