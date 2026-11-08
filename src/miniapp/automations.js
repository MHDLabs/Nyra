// Mini App Automations API: reminders list, proactive settings, schedules CRUD.
import { getUserStrict } from "../db.js";
import { listReminders, countReminders, cancelReminder, completeReminder, getUserTimezone, setUserTimezone } from "../db/reminders.js";
import {
  listSchedules, createSchedule, updateSchedule, deleteSchedule, getScheduleById,
  countUserSchedules, SCHEDULE_KINDS, GENERATION_MODES, MAX_SCHEDULES_PER_USER,
  parseLocalTime, defaultTemplate
} from "../db/schedules.js";
import { isValidTimeZone } from "../reminders/tz.js";
import { now } from "../utils.js";
import { jsonOk, jsonError } from "./respond.js";

async function loadUser(env, userId) {
  try { return await getUserStrict(env, userId); }
  catch (err) { return null; }
}

export async function handleAutomationsOverview(env, userId) {
  const user = await loadUser(env, userId);
  if (!user) return jsonError(404, "User not found");
  const reminders = await listReminders(env, userId, { limit: 20 });
  const schedules = await listSchedules(env, userId);
  const tz = user.timezone || null;
  return jsonOk({
    timezone: tz,
    proactive: {
      enabled: !!(user.proactive_enabled === 1 || user.proactive_enabled === true),
      threshold_hours: Number(user.proactive_threshold_hours) || 24,
      quiet_start: user.proactive_quiet_start != null ? Number(user.proactive_quiet_start) : null,
      quiet_end: user.proactive_quiet_end != null ? Number(user.proactive_quiet_end) : null,
      last_inbound_at: user.last_inbound_at || null,
      last_sent_at: user.proactive_last_sent_at || null
    },
    reminders: (reminders || []).map(function (r) {
      return {
        id: r.id,
        title: r.title,
        status: r.status,
        next_run_at: r.next_run_at,
        timezone: r.timezone,
        recurrence: r.recurrence || null
      };
    }),
    schedules: schedules
  });
}

export async function handleUpdateProactive(env, userId, body) {
  const user = await loadUser(env, userId);
  if (!user) return jsonError(404, "User not found");
  if (!body || typeof body !== "object") return jsonError(400, "Invalid body");

  const enabled = body.enabled === true || body.enabled === 1 || body.enabled === "1" ? 1 : 0;
  let threshold = Number(body.threshold_hours);
  if (!Number.isFinite(threshold) || threshold < 1) threshold = 24;
  if (threshold > 168) threshold = 168;
  let quietStart = body.quiet_start;
  let quietEnd = body.quiet_end;
  if (quietStart !== null && quietStart !== undefined && quietStart !== "") {
    quietStart = Number(quietStart);
    if (!Number.isInteger(quietStart) || quietStart < 0 || quietStart > 23) return jsonError(400, "Invalid quiet_start");
  } else quietStart = null;
  if (quietEnd !== null && quietEnd !== undefined && quietEnd !== "") {
    quietEnd = Number(quietEnd);
    if (!Number.isInteger(quietEnd) || quietEnd < 0 || quietEnd > 23) return jsonError(400, "Invalid quiet_end");
  } else quietEnd = null;

  try {
    await env.DB.prepare(
      "UPDATE users SET proactive_enabled = ?, proactive_threshold_hours = ?, proactive_quiet_start = ?, proactive_quiet_end = ?, updated_at = ? WHERE telegram_id = ?"
    ).bind(enabled, threshold, quietStart, quietEnd, now(), userId).run();
  } catch (err) {
    console.error("handleUpdateProactive failed:", err.message);
    return jsonError(500, "Failed to update settings");
  }
  return jsonOk({ success: true });
}

export async function handleSetTimezone(env, userId, body) {
  const zone = body && body.timezone ? String(body.timezone).trim() : "";
  if (!zone || !isValidTimeZone(zone)) return jsonError(400, "Invalid timezone");
  const ok = await setUserTimezone(env, userId, zone);
  if (!ok) return jsonError(500, "Failed to save timezone");
  return jsonOk({ success: true, timezone: zone });
}

export async function handleCreateSchedule(env, userId, body) {
  if (!body || typeof body !== "object") return jsonError(400, "Invalid body");
  const kind = String(body.kind || "custom");
  if (SCHEDULE_KINDS.indexOf(kind) === -1) return jsonError(400, "Invalid kind");
  const title = String(body.title || kind).trim().slice(0, 120);
  if (!title) return jsonError(400, "Title required");
  const localTime = String(body.local_time || "").trim();
  if (!parseLocalTime(localTime)) return jsonError(400, "Invalid local_time (HH:MM)");
  const user = await loadUser(env, userId);
  if (!user) return jsonError(404, "User not found");
  const timezone = String(body.timezone || user.timezone || "").trim();
  if (!timezone || !isValidTimeZone(timezone)) return jsonError(400, "Timezone required");
  const generation_mode = GENERATION_MODES.indexOf(body.generation_mode) !== -1 ? body.generation_mode : "template";
  let days = null;
  if (Array.isArray(body.days_of_week)) {
    days = body.days_of_week.map(Number).filter(function (d) { return Number.isInteger(d) && d >= 0 && d <= 6; });
    if (!days.length) days = null;
  }
  if (kind === "weekly" && !days) {
    // Default weekly to Monday rather than silently becoming daily.
    days = [1];
  }
  const count = await countUserSchedules(env, userId);
  if (count >= MAX_SCHEDULES_PER_USER) return jsonError(400, "Schedule limit reached");

  const result = await createSchedule(env, {
    telegram_id: userId,
    chat_id: userId,
    kind: kind,
    title: title,
    message_text: body.message_text || null,
    generation_mode: generation_mode,
    recurrence: kind === "weekly" ? "weekly" : "daily",
    local_time: localTime,
    timezone: timezone,
    days_of_week: days
  });
  if (!result.ok) return jsonError(400, result.reason || "Failed to create");
  const created = await getScheduleById(env, result.id, userId);
  return jsonOk({ success: true, schedule: created });
}

export async function handleUpdateSchedule(env, userId, id, body) {
  const sid = parseInt(id, 10);
  if (!Number.isInteger(sid) || sid <= 0) return jsonError(400, "Invalid id");
  if (!body || typeof body !== "object") return jsonError(400, "Invalid body");
  if (body.local_time && !parseLocalTime(body.local_time)) return jsonError(400, "Invalid local_time");
  if (body.timezone && !isValidTimeZone(body.timezone)) return jsonError(400, "Invalid timezone");
  if (body.generation_mode && GENERATION_MODES.indexOf(body.generation_mode) === -1) {
    return jsonError(400, "Invalid generation_mode");
  }
  const result = await updateSchedule(env, sid, userId, body);
  if (!result.ok) return jsonError(result.reason === "not_found" ? 404 : 400, result.reason || "Failed");
  const updated = await getScheduleById(env, sid, userId);
  return jsonOk({ success: true, schedule: updated });
}

export async function handleDeleteSchedule(env, userId, id) {
  const sid = parseInt(id, 10);
  if (!Number.isInteger(sid) || sid <= 0) return jsonError(400, "Invalid id");
  const ok = await deleteSchedule(env, sid, userId);
  if (!ok) return jsonError(404, "Not found");
  return jsonOk({ success: true });
}

export async function handleReminderAction(env, userId, id, action) {
  const rid = parseInt(id, 10);
  if (!Number.isInteger(rid) || rid <= 0) return jsonError(400, "Invalid id");
  if (action === "cancel") {
    const ok = await cancelReminder(env, rid, userId);
    if (!ok) return jsonError(404, "Not found");
    return jsonOk({ success: true });
  }
  if (action === "done" || action === "complete") {
    const ok = await completeReminder(env, rid, userId);
    if (!ok) return jsonError(404, "Not found");
    return jsonOk({ success: true });
  }
  return jsonError(400, "Unknown action");
}

export async function handleSchedulePreview(env, userId, body) {
  const kind = String((body && body.kind) || "custom");
  const user = await loadUser(env, userId);
  const lang = user && (user.locale || user.language_code || "").toString().toLowerCase().indexOf("en") === 0 ? "en" : "fa";
  const text = (body && body.message_text) ? String(body.message_text).slice(0, 500) : defaultTemplate(kind, lang);
  return jsonOk({ preview: text, kind: kind });
}
