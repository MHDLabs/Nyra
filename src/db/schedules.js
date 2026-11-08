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

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, weekday: "short"
  });
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  function partsAt(sec) {
    const parts = {};
    dtf.formatToParts(new Date(sec * 1000)).forEach(function (p) { parts[p.type] = p.value; });
    return {
      year: parseInt(parts.year, 10),
      month: parseInt(parts.month, 10),
      day: parseInt(parts.day, 10),
      hour: parseInt(parts.hour, 10) % 24,
      minute: parseInt(parts.minute, 10),
      second: parseInt(parts.second, 10),
      dow: weekdayMap[parts.weekday]
    };
  }

  // Find UTC seconds whose zoned wall clock equals target H:M on the same civil day as probeSec's date.
  function utcForLocalOnDay(probeSec) {
    const p0 = partsAt(probeSec);
    // Search a 50h window centered near probe to cover offset extremes.
    let lo = probeSec - 36 * 3600;
    let hi = probeSec + 36 * 3600;
    let found = null;
    // Binary search for the first second where local H:M >= target on that civil date.
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const p = partsAt(mid);
      const sameDay = p.year === p0.year && p.month === p0.month && p.day === p0.day;
      const mins = p.hour * 60 + p.minute;
      const targetMins = parsed.hour * 60 + parsed.minute;
      if (!sameDay) {
        if (p.year < p0.year || (p.year === p0.year && (p.month < p0.month || (p.month === p0.month && p.day < p0.day)))) lo = mid + 1;
        else hi = mid - 1;
        continue;
      }
      if (mins > targetMins || (mins === targetMins && p.second > 0)) { hi = mid - 1; }
      else if (mins < targetMins) { lo = mid + 1; }
      else {
        found = mid - p.second; // snap to :00
        hi = mid - 1; // look for earlier second in ambiguous overlap
      }
    }
    if (found == null) return null;
    // Verify wall clock matches (non-existent local times yield null).
    const v = partsAt(found);
    if (v.year !== p0.year || v.month !== p0.month || v.day !== p0.day) return null;
    if (v.hour !== parsed.hour || v.minute !== parsed.minute) return null;
    return found;
  }

  for (let dayOffset = 0; dayOffset < 21; dayOffset++) {
    const probe = from + dayOffset * 86400;
    const p = partsAt(probe);
    if (daySet && !daySet.has(p.dow)) continue;
    // Noon UTC-ish probe on that local day for stability
    const noonGuess = probe - ((p.hour * 60 + p.minute) * 60) + 12 * 3600;
    const candidate = utcForLocalOnDay(noonGuess);
    if (candidate != null && candidate >= from) return candidate;
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
  let dayList = data.days_of_week;
  if (data.kind === "weekly" && (!Array.isArray(dayList) || !dayList.length)) {
    dayList = [1]; // Monday — never treat weekly as unconstrained daily
  }
  const next = computeNextRunAt(data.local_time, data.timezone, dayList, ts);
  if (!next) return { ok: false, reason: "bad_schedule" };
  const days = Array.isArray(dayList) && dayList.length ? dayList.join(",") : null;
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
