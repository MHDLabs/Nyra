// Personal message schedules (good morning / good night / custom).
// Distinct from task reminders: these are recurring social/automation messages.
import { now } from "../utils.js";
import { isValidTimeZone } from "../reminders/tz.js";

export const SCHEDULE_KINDS = ["good_morning", "good_night", "custom", "weekly"];
export const GENERATION_MODES = ["template", "personality"];
export const MAX_SCHEDULES_PER_USER = 20;
export const MAX_SCHEDULE_TITLE = 120;
export const MAX_SCHEDULE_MESSAGE = 500;

const DEFAULT_TEMPLATES = {
  good_morning: { fa: "صبح بخیر! روزت پر از انرژی باشه ☀️", en: "Good morning! Hope you have a great day ☀️" },
  good_night: { fa: "شب بخیر. استراحت خوبی داشته باشی 🌙", en: "Good night. Rest well 🌙" },
  custom: { fa: "یادآوری دوستانه از نایرا.", en: "A friendly note from Nyra." },
  weekly: { fa: "شروع هفته‌ات مبارک!", en: "Have a great start to the week!" }
};

export function defaultTemplate(kind, lang) {
  const k = DEFAULT_TEMPLATES[kind] || DEFAULT_TEMPLATES.custom;
  return lang === "en" ? k.en : k.fa;
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    telegram_id: row.telegram_id,
    chat_id: row.chat_id,
    kind: row.kind,
    title: row.title,
    message_text: row.message_text,
    generation_mode: row.generation_mode || "template",
    recurrence: row.recurrence,
    local_time: row.local_time,
    timezone: row.timezone,
    days_of_week: row.days_of_week ? String(row.days_of_week).split(",").map(Number).filter(Number.isFinite) : null,
    enabled: row.enabled === 1 || row.enabled === true,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    last_status: row.last_status,
    attempts: row.attempts || 0,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

/** Parse HH:MM local wall-clock time. */
export function parseLocalTime(s) {
  const m = String(s || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { hour: h, minute: min };
}

/**
 * Next UTC instant for a local HH:MM in an IANA zone, optionally restricted to
 * days_of_week (0=Sun..6=Sat). Skips the current minute so "create at 09:00"
 * does not fire immediately if it is already 09:00.
 */
export function computeNextRunAt(localTime, timezone, daysOfWeek, fromSec) {
  const parsed = parseLocalTime(localTime);
  if (!parsed || !isValidTimeZone(timezone)) return null;
  const from = (Number.isFinite(fromSec) ? fromSec : now()) + 60;
  const daySet = Array.isArray(daysOfWeek) && daysOfWeek.length
    ? new Set(daysOfWeek.map(Number).filter(function (d) { return d >= 0 && d <= 6; }))
    : null;

  for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
    const probe = new Date((from + dayOffset * 86400) * 1000);
    // Build candidate local date parts in the target zone.
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false, weekday: "short"
    });
    // Walk minute-by-minute near the target local time is expensive; instead
    // construct a UTC guess from the zoned parts of `probe` and adjust.
    const parts = {};
    fmt.formatToParts(probe).forEach(function (p) { parts[p.type] = p.value; });
    const y = parseInt(parts.year, 10);
    const mo = parseInt(parts.month, 10);
    const d = parseInt(parts.day, 10);
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dow = weekdayMap[parts.weekday];
    if (daySet && !daySet.has(dow)) continue;

    // Approximate: treat local wall time as if UTC then shift by zone offset.
    const asUtc = Date.UTC(y, mo - 1, d, parsed.hour, parsed.minute, 0) / 1000;
    // Measure offset of this zone at that civil date.
    const again = new Date(asUtc * 1000);
    const parts2 = {};
    fmt.formatToParts(again).forEach(function (p) { parts2[p.type] = p.value; });
    const localAsUtc = Date.UTC(
      parseInt(parts2.year, 10), parseInt(parts2.month, 10) - 1, parseInt(parts2.day, 10),
      parseInt(parts2.hour, 10) % 24, parseInt(parts2.minute, 10), 0
    ) / 1000;
    const offset = localAsUtc - asUtc;
    const candidate = asUtc - offset;
    if (candidate >= from) return Math.floor(candidate);
  }
  return null;
}

export async function countUserSchedules(env, telegramId) {
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM schedules WHERE telegram_id = ?"
    ).bind(telegramId).first();
    return row ? Number(row.c) || 0 : 0;
  } catch (err) {
    console.error("countUserSchedules failed:", err.message);
    return 0;
  }
}

export async function listSchedules(env, telegramId) {
  try {
    const res = await env.DB.prepare(
      "SELECT * FROM schedules WHERE telegram_id = ? ORDER BY enabled DESC, next_run_at ASC, id ASC"
    ).bind(telegramId).all();
    return (res.results || []).map(hydrate);
  } catch (err) {
    console.error("listSchedules failed:", err.message);
    return [];
  }
}

export async function getScheduleById(env, id, telegramId) {
  try {
    const row = await env.DB.prepare(
      "SELECT * FROM schedules WHERE id = ? AND telegram_id = ?"
    ).bind(id, telegramId).first();
    return hydrate(row);
  } catch (err) {
    return null;
  }
}

export async function createSchedule(env, data) {
  const ts = now();
  let days = data.days_of_week;
  if (data.kind === "weekly" && (!Array.isArray(days) || !days.length)) {
    days = [1]; // Monday — never treat weekly as unconstrained daily
  }
  const next = computeNextRunAt(data.local_time, data.timezone, days, ts);
  if (!next) return { ok: false, reason: "bad_schedule" };
  data = Object.assign({}, data, { days_of_week: days });
  const days = Array.isArray(data.days_of_week) && data.days_of_week.length
    ? data.days_of_week.join(",")
    : null;
  try {
    const result = await env.DB.prepare(
      "INSERT INTO schedules (telegram_id, chat_id, kind, title, message_text, generation_mode, recurrence, local_time, timezone, days_of_week, enabled, next_run_at, attempts, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)"
    ).bind(
      data.telegram_id,
      data.chat_id || data.telegram_id,
      data.kind,
      String(data.title).slice(0, MAX_SCHEDULE_TITLE),
      data.message_text ? String(data.message_text).slice(0, MAX_SCHEDULE_MESSAGE) : null,
      data.generation_mode || "template",
      data.recurrence || "daily",
      data.local_time,
      data.timezone,
      days,
      next,
      ts,
      ts
    ).run();
    const id = result.meta && result.meta.last_row_id;
    return { ok: true, id: id, next_run_at: next };
  } catch (err) {
    console.error("createSchedule failed:", err.message);
    return { ok: false, reason: "db" };
  }
}

export async function updateSchedule(env, id, telegramId, patch) {
  const existing = await getScheduleById(env, id, telegramId);
  if (!existing) return { ok: false, reason: "not_found" };
  const ts = now();
  const title = patch.title !== undefined ? String(patch.title).slice(0, MAX_SCHEDULE_TITLE) : existing.title;
  const message_text = patch.message_text !== undefined
    ? (patch.message_text ? String(patch.message_text).slice(0, MAX_SCHEDULE_MESSAGE) : null)
    : existing.message_text;
  const generation_mode = patch.generation_mode || existing.generation_mode;
  const local_time = patch.local_time || existing.local_time;
  const timezone = patch.timezone || existing.timezone;
  const days_of_week = patch.days_of_week !== undefined ? patch.days_of_week : existing.days_of_week;
  const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (existing.enabled ? 1 : 0);
  const next = enabled
    ? computeNextRunAt(local_time, timezone, days_of_week, ts)
    : null;
  const days = Array.isArray(days_of_week) && days_of_week.length ? days_of_week.join(",") : null;
  try {
    await env.DB.prepare(
      "UPDATE schedules SET title = ?, message_text = ?, generation_mode = ?, local_time = ?, timezone = ?, days_of_week = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ? AND telegram_id = ?"
    ).bind(title, message_text, generation_mode, local_time, timezone, days, enabled, next, ts, id, telegramId).run();
    return { ok: true, next_run_at: next };
  } catch (err) {
    console.error("updateSchedule failed:", err.message);
    return { ok: false, reason: "db" };
  }
}

export async function deleteSchedule(env, id, telegramId) {
  try {
    const result = await env.DB.prepare(
      "DELETE FROM schedules WHERE id = ? AND telegram_id = ?"
    ).bind(id, telegramId).run();
    return !!(result.meta && result.meta.changes > 0);
  } catch (err) {
    return false;
  }
}

export async function claimDueSchedules(env, nowSec, limit) {
  const ts = Number.isFinite(nowSec) ? nowSec : now();
  const batch = Math.min(Math.max(limit || 15, 1), 30);
  try {
    const res = await env.DB.prepare(
      "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? " +
      "AND (claim_token IS NULL OR claimed_at IS NULL OR claimed_at < ?) " +
      "ORDER BY next_run_at ASC, id ASC LIMIT ?"
    ).bind(ts, ts - 300, batch).all();
    const rows = res.results || [];
    const claimed = [];
    for (let i = 0; i < rows.length; i++) {
      const token = "s" + ts + "_" + rows[i].id + "_" + Math.random().toString(36).slice(2, 8);
      const upd = await env.DB.prepare(
        "UPDATE schedules SET claim_token = ?, claimed_at = ?, attempts = attempts + 1, updated_at = ? " +
        "WHERE id = ? AND (claim_token IS NULL OR claimed_at IS NULL OR claimed_at < ?)"
      ).bind(token, ts, ts, rows[i].id, ts - 300).run();
      if (upd.meta && upd.meta.changes > 0) {
        const h = hydrate(rows[i]);
        h.claim_token = token;
        claimed.push(h);
      }
    }
    return claimed;
  } catch (err) {
    console.error("claimDueSchedules failed:", err.message);
    return [];
  }
}

export async function settleScheduleDelivery(env, id, claimToken, nextRunAt, status) {
  const ts = now();
  try {
    await env.DB.prepare(
      "UPDATE schedules SET claim_token = NULL, claimed_at = NULL, last_run_at = ?, last_status = ?, next_run_at = ?, updated_at = ? " +
      "WHERE id = ? AND claim_token = ?"
    ).bind(ts, status || "sent", nextRunAt, ts, id, claimToken).run();
  } catch (err) {
    console.error("settleScheduleDelivery failed:", err.message);
  }
}

export async function releaseScheduleForRetry(env, id, claimToken) {
  const ts = now();
  try {
    await env.DB.prepare(
      "UPDATE schedules SET claim_token = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND claim_token = ?"
    ).bind(ts, id, claimToken).run();
  } catch (err) {}
}
