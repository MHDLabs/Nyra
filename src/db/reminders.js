// Reminders: owner-scoped persistence for scheduled tasks plus the atomic
// claim/lease protocol the cron delivery loop relies on.
//
// Two things matter here and everything else is bookkeeping:
//
//  1. Every read and write that is reachable from a user-facing surface takes
//     `telegramId` and puts it in the WHERE clause. Ownership is never inferred
//     from "the caller knew the id". `getReminderById` cannot return another
//     user's row, so a guessed id leaks nothing and an id alone never
//     authorizes a mutation.
//
//  2. Delivery must not double-send when two cron invocations overlap, and must
//     not lose a reminder when a worker dies mid-delivery. `claimDueReminders`
//     flips rows to `processing` with a unique token; only the worker holding
//     that token can settle the row, and `recoverStaleClaims` returns rows whose
//     lease expired to `pending` so the next tick retries them.
//
// Time unit: every instant crossing this boundary is UTC **seconds** (`now()`),
// matching the rest of the codebase. Millisecond arithmetic stays inside
// `src/reminders/` and is converted before it gets here.
import { MAX_REMINDER_TITLE, MAX_REMINDER_DESCRIPTION, MAX_REMINDERS_PER_USER, REMINDER_LIST_PAGE, REMINDER_STATUSES } from "../config.js";
import { now } from "../utils.js";

const ATTEMPTS_KEEP = 20;

// Prepared statements with a runtime-variable bind list. D1 exposes `bind(...)`
// as a rest-parameter method, so a spread is the honest way to call it; these
// helpers keep the call sites readable instead of writing
// `env.DB.prepare(sql).bind(...binds)` inline at every site.
function all(env, sql, binds) {
  return env.DB.prepare(sql).bind(...binds).all();
}

function run(env, sql, binds) {
  return env.DB.prepare(sql).bind(...binds).run();
}

function first(env, sql, binds) {
  return env.DB.prepare(sql).bind(...binds).first();
}

function clampText(value, max) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Parse the stored recurrence JSON. A row whose recurrence cannot be parsed is
 * treated as a one-shot reminder rather than an error: a corrupt value must not
 * make an otherwise valid reminder undeliverable.
 */
function parseRecurrence(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.bucket || !parsed.interval) return null;
    return parsed;
  } catch (err) {
    console.error("Reminder recurrence parse failed:", err.message);
    return null;
  }
}

/** Normalise a DB row into the shape the reminder layer uses everywhere. */
export function hydrateReminder(row) {
  if (!row) return null;
  return {
    id: row.id,
    telegramId: row.telegram_id,
    chatId: row.chat_id === null || row.chat_id === undefined ? row.telegram_id : row.chat_id,
    title: row.title || "",
    description: row.description || "",
    startAt: row.start_at,
    nextRunAt: row.next_run_at,
    timezone: row.timezone,
    status: row.status,
    recurrence: parseRecurrence(row.recurrence),
    occurrence: row.occurrence || 0,
    attempts: row.attempts || 0,
    claimToken: row.claim_token || null,
    claimedAt: row.claimed_at || null,
    lastAttemptAt: row.last_attempt_at || null,
    lastError: row.last_error || null,
    sentAt: row.sent_at || null,
    completedAt: row.completed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Statuses that still occupy a slot against MAX_REMINDERS_PER_USER. */
const ACTIVE_STATUSES = ["pending", "processing"];

export async function countActiveReminders(env, telegramId) {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS c FROM reminders WHERE telegram_id = ? AND status IN ('pending','processing')")
    .bind(telegramId).first();
  return row && Number.isFinite(row.c) ? row.c : 0;
}

/**
 * Persist a new reminder. Returns `{ ok: true, reminder }` or
 * `{ ok: false, reason }` — a refusal is a normal outcome (quota, bad input)
 * and the caller decides what to tell the user, so this never throws for them.
 */
export async function createReminder(env, data) {
  const telegramId = data.telegramId;
  const title = clampText(data.title, MAX_REMINDER_TITLE);
  if (!Number.isFinite(telegramId)) return { ok: false, reason: "no_user" };
  if (!title) return { ok: false, reason: "no_title" };
  if (!Number.isFinite(data.startAt)) return { ok: false, reason: "no_time" };
  if (!data.timezone) return { ok: false, reason: "no_timezone" };

  const active = await countActiveReminders(env, telegramId);
  if (active >= MAX_REMINDERS_PER_USER) return { ok: false, reason: "quota" };

  const ts = now();
  const nextRunAt = Number.isFinite(data.nextRunAt) ? data.nextRunAt : data.startAt;
  try {
    const result = await env.DB.prepare(
      "INSERT INTO reminders (telegram_id, chat_id, title, description, start_at, next_run_at, timezone, status, recurrence, occurrence, attempts, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, 0, ?, ?)"
    ).bind(
      telegramId,
      Number.isFinite(data.chatId) ? data.chatId : telegramId,
      title,
      clampText(data.description, MAX_REMINDER_DESCRIPTION) || null,
      data.startAt,
      nextRunAt,
      data.timezone,
      data.recurrence ? JSON.stringify(data.recurrence) : null,
      ts,
      ts
    ).run();
    const id = result && result.meta ? result.meta.last_row_id : null;
    if (!id) return { ok: false, reason: "db_error" };
    const reminder = await getReminderById(env, id, telegramId);
    return { ok: true, reminder: reminder };
  } catch (err) {
    console.error("createReminder failed:", err.message);
    return { ok: false, reason: "db_error" };
  }
}

/** Owner-scoped single read. A non-owner id returns null, never another row. */
export async function getReminderById(env, id, telegramId) {
  if (!Number.isFinite(id) || !Number.isFinite(telegramId)) return null;
  try {
    const row = await env.DB.prepare("SELECT * FROM reminders WHERE id = ? AND telegram_id = ?").bind(id, telegramId).first();
    return hydrateReminder(row);
  } catch (err) {
    console.error("getReminderById failed:", err.message);
    return null;
  }
}

/**
 * Owner-scoped page of reminders, soonest first. Keyset paging (`beforeId`
 * cursor) is used instead of OFFSET so a reminder created mid-browse cannot
 * shift a row onto a page the user already saw.
 */
export async function listReminders(env, telegramId, opts) {
  const options = opts || {};
  const limit = Math.min(Math.max(Number.isFinite(options.limit) ? options.limit : REMINDER_LIST_PAGE, 1), 50);
  const statuses = Array.isArray(options.statuses) && options.statuses.length
    ? options.statuses.filter(function (s) { return REMINDER_STATUSES.indexOf(s) !== -1; })
    : ACTIVE_STATUSES;
  if (!statuses.length) return [];
  if (!Number.isFinite(telegramId)) return [];
  const placeholders = statuses.map(function () { return "?"; }).join(",");
  let sql = "SELECT * FROM reminders WHERE telegram_id = ? AND status IN (" + placeholders + ")";
  const binds = [telegramId].concat(statuses);
  if (Number.isFinite(options.beforeId)) {
    // Keyset on (next_run_at, id): both columns are in idx_reminders_user.
    const anchor = await env.DB.prepare("SELECT next_run_at, id FROM reminders WHERE id = ? AND telegram_id = ?").bind(options.beforeId, telegramId).first();
    if (!anchor) return [];
    sql += " AND (next_run_at > ? OR (next_run_at = ? AND id > ?))";
    binds.push(anchor.next_run_at, anchor.next_run_at, anchor.id);
  }
  sql += " ORDER BY next_run_at ASC, id ASC LIMIT ?";
  binds.push(limit);
  try {
    const result = await all(env, sql, binds);
    return (result.results || []).map(hydrateReminder);
  } catch (err) {
    console.error("listReminders failed:", err.message);
    return [];
  }
}

/** Total count for a page header. Owner-scoped, indexed by idx_reminders_user. */
export async function countReminders(env, telegramId, statuses) {
  const list = Array.isArray(statuses) && statuses.length ? statuses : ACTIVE_STATUSES;
  const placeholders = list.map(function () { return "?"; }).join(",");
  try {
    const row = await first(env, "SELECT COUNT(*) AS c FROM reminders WHERE telegram_id = ? AND status IN (" + placeholders + ")", [telegramId].concat(list));
    return row && Number.isFinite(row.c) ? row.c : 0;
  } catch (err) {
    console.error("countReminders failed:", err.message);
    return 0;
  }
}

const EDITABLE_COLUMNS = {
  title: "title",
  description: "description",
  startAt: "start_at",
  nextRunAt: "next_run_at",
  timezone: "timezone",
  recurrence: "recurrence"
};

/**
 * Owner-scoped partial update. Only whitelisted columns are ever written, so a
 * patch object can never reach `telegram_id`, `claim_token` or `status`.
 * Returns the updated reminder, or null when the row does not exist for this
 * owner (or nothing changed).
 */
export async function updateReminder(env, id, telegramId, patch) {
  if (!Number.isFinite(id) || !Number.isFinite(telegramId) || !patch) return null;
  const sets = [];
  const binds = [];
  for (const key of Object.keys(patch)) {
    const column = EDITABLE_COLUMNS[key];
    if (!column) continue;
    let value = patch[key];
    if (key === "title") value = clampText(value, MAX_REMINDER_TITLE);
    if (key === "description") value = clampText(value, MAX_REMINDER_DESCRIPTION) || null;
    if (key === "recurrence") value = value ? JSON.stringify(value) : null;
    if (key === "startAt" || key === "nextRunAt") { if (!Number.isFinite(value)) continue; }
    if (key === "timezone" && !value) continue;
    sets.push(column + " = ?");
    binds.push(value);
  }
  if (!sets.length) return await getReminderById(env, id, telegramId);
  sets.push("updated_at = ?");
  binds.push(now());
  // Re-arming a reminder clears the previous failure trail: a user who edits a
  // reminder that had exhausted its retries expects it to be tried again.
  if (patch.recurrence !== undefined || patch.startAt !== undefined || patch.nextRunAt !== undefined) {
    sets.push("attempts = 0", "last_error = NULL", "claim_token = NULL", "claimed_at = NULL");
  }
  try {
    const result = await run(env, "UPDATE reminders SET " + sets.join(", ") + " WHERE id = ? AND telegram_id = ?", binds.concat([id, telegramId]));
    if (!result || !result.meta || result.meta.changes !== 1) {
      // The row may still exist (a no-op update reports 0 changes), so fall back
      // to a read instead of reporting "not found" for an unchanged edit.
      return await getReminderById(env, id, telegramId);
    }
    return await getReminderById(env, id, telegramId);
  } catch (err) {
    console.error("updateReminder failed:", err.message);
    return null;
  }
}

/** Owner-scoped cancel. Only a live reminder can be cancelled. */
export async function cancelReminder(env, id, telegramId) {
  if (!Number.isFinite(id) || !Number.isFinite(telegramId)) return false;
  try {
    const result = await env.DB.prepare(
      "UPDATE reminders SET status = 'cancelled', claim_token = NULL, claimed_at = NULL, updated_at = ? " +
      "WHERE id = ? AND telegram_id = ? AND status IN ('pending','processing')"
    ).bind(now(), id, telegramId).run();
    return !!(result && result.meta && result.meta.changes === 1);
  } catch (err) {
    console.error("cancelReminder failed:", err.message);
    return false;
  }
}

/** Owner-scoped "mark done". Applies to a live or already-sent one-shot. */
export async function completeReminder(env, id, telegramId) {
  if (!Number.isFinite(id) || !Number.isFinite(telegramId)) return false;
  const ts = now();
  try {
    const result = await env.DB.prepare(
      "UPDATE reminders SET status = 'completed', completed_at = ?, claim_token = NULL, claimed_at = NULL, updated_at = ? " +
      "WHERE id = ? AND telegram_id = ? AND status IN ('pending','processing','sent')"
    ).bind(ts, ts, id, telegramId).run();
    return !!(result && result.meta && result.meta.changes === 1);
  } catch (err) {
    console.error("completeReminder failed:", err.message);
    return false;
  }
}

/**
 * Atomically claim up to `limit` due reminders.
 *
 * Three round trips, deliberately:
 *   1. pick candidate ids (index-covered: idx_reminders_due);
 *   2. batch conditional updates — `WHERE status = 'pending'` means a row
 *      another worker already took reports 0 changes and is skipped;
 *   3. read back only the rows this call actually owns, selected by the unique
 *      claim token.
 *
 * The token is what makes step 3 safe: a row claimed by a concurrent worker has
 * a different token, so it can never be settled by this invocation.
 *
 * Returns hydrated reminders. Throws on D1 failure — the caller (the scheduled
 * handler) logs it; swallowing it here would silently stop all delivery.
 */
export async function claimDueReminders(env, nowSec, limit) {
  const token = crypto.randomUUID();
  const candidates = await env.DB.prepare(
    "SELECT id FROM reminders WHERE status = 'pending' AND next_run_at <= ? ORDER BY next_run_at ASC, id ASC LIMIT ?"
  ).bind(nowSec, limit).all();
  const ids = (candidates.results || []).map(function (r) { return r.id; });
  if (!ids.length) return [];

  const updates = ids.map(function (id) {
    return env.DB.prepare(
      "UPDATE reminders SET status = 'processing', claim_token = ?, claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'"
    ).bind(token, nowSec, nowSec, id);
  });
  // One batch = one implicit transaction, so a partial claim cannot be visible.
  const results = await env.DB.batch(updates);
  const won = [];
  for (let i = 0; i < ids.length; i++) {
    const r = results && results[i];
    if (r && r.meta && r.meta.changes === 1) won.push(ids[i]);
  }
  if (!won.length) return [];

  const placeholders = won.map(function () { return "?"; }).join(",");
  const claimed = await all(env,
    "SELECT * FROM reminders WHERE claim_token = ? AND status = 'processing' AND id IN (" + placeholders + ") ORDER BY next_run_at ASC, id ASC",
    [token].concat(won));
  return (claimed.results || []).map(hydrateReminder);
}

/**
 * Return reminders whose lease expired to `pending` so the next tick retries
 * them. This is the crash-recovery path: a worker that died after claiming but
 * before settling leaves rows stuck in `processing`, and without this they would
 * never fire again.
 *
 * Returns the number of recovered rows.
 */
export async function recoverStaleClaims(env, nowSec, leaseSeconds) {
  try {
    const result = await env.DB.prepare(
      "UPDATE reminders SET status = 'pending', claim_token = NULL, claimed_at = NULL, updated_at = ? " +
      "WHERE status = 'processing' AND claimed_at IS NOT NULL AND claimed_at < ?"
    ).bind(nowSec, nowSec - leaseSeconds).run();
    const recovered = result && result.meta ? result.meta.changes : 0;
    if (recovered > 0) console.log("Recovered " + recovered + " stale reminder claim(s).");
    return recovered;
  } catch (err) {
    console.error("recoverStaleClaims failed:", err.message);
    return 0;
  }
}

/** Record one delivery attempt. Best-effort: an audit-trail failure is logged,
 * never allowed to change the outcome of an already-attempted send. */
export async function recordDeliveryAttempt(env, reminderId, attempt, status, error) {
  try {
    await env.DB.prepare(
      "INSERT INTO reminder_delivery_attempts (reminder_id, attempt, status, error, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(reminderId, attempt, status, error ? String(error).slice(0, 500) : null, now()).run();
  } catch (err) {
    console.error("recordDeliveryAttempt failed:", err.message);
  }
}

export async function listDeliveryAttempts(env, reminderId, limit) {
  try {
    const result = await env.DB.prepare(
      "SELECT * FROM reminder_delivery_attempts WHERE reminder_id = ? ORDER BY created_at DESC LIMIT ?"
    ).bind(reminderId, Math.min(Number.isFinite(limit) ? limit : ATTEMPTS_KEEP, 100)).all();
    return result.results || [];
  } catch (err) {
    return [];
  }
}

/**
 * Retryable failure: hand the row back to `pending` at a later due time.
 * Guarded by the claim token so a worker whose lease was already recovered
 * cannot reschedule a row that another invocation now owns.
 */
export async function releaseReminderForRetry(env, id, claimToken, error, nextAttemptAt, attempts) {
  try {
    const result = await env.DB.prepare(
      "UPDATE reminders SET status = 'pending', claim_token = NULL, claimed_at = NULL, attempts = ?, last_attempt_at = ?, last_error = ?, next_run_at = ?, updated_at = ? " +
      "WHERE id = ? AND claim_token = ?"
    ).bind(attempts, now(), error ? String(error).slice(0, 500) : null, nextAttemptAt, now(), id, claimToken).run();
    return !!(result && result.meta && result.meta.changes === 1);
  } catch (err) {
    console.error("releaseReminderForRetry failed:", err.message);
    return false;
  }
}

/**
 * Terminal failure: the reminder will not be retried (permanent Telegram error
 * such as a blocked bot, or the retry budget is exhausted). The row is kept —
 * the user can still see and fix it, and the attempt log explains why.
 */
export async function failReminderPermanently(env, id, claimToken, error, attempts) {
  try {
    const result = await env.DB.prepare(
      "UPDATE reminders SET status = 'failed', claim_token = NULL, claimed_at = NULL, attempts = ?, last_attempt_at = ?, last_error = ?, updated_at = ? " +
      "WHERE id = ? AND claim_token = ?"
    ).bind(attempts, now(), error ? String(error).slice(0, 500) : null, now(), id, claimToken).run();
    return !!(result && result.meta && result.meta.changes === 1);
  } catch (err) {
    console.error("failReminderPermanently failed:", err.message);
    return false;
  }
}

/**
 * Delivery succeeded. Two shapes:
 *   * recurring → stays `pending`, `next_run_at` advances to the next
 *     occurrence, `attempts` resets. `occurrence` counts how many have fired.
 *   * one-shot → becomes `sent`.
 *
 * `nextRunAt`/`occurrence` are computed by the caller from the recurrence
 * anchor, so a missed cron tick cannot drop an occurrence: the next instant is
 * always derived from the original anchor, not from "now".
 */
export async function settleReminderDelivery(env, id, claimToken, next) {
  const ts = now();
  try {
    let sql;
    let binds;
    if (next && Number.isFinite(next.nextRunAt)) {
      sql = "UPDATE reminders SET status = 'pending', next_run_at = ?, occurrence = ?, attempts = 0, claim_token = NULL, claimed_at = NULL, last_attempt_at = ?, last_error = NULL, sent_at = ?, updated_at = ? WHERE id = ? AND claim_token = ?";
      binds = [next.nextRunAt, Number.isFinite(next.occurrence) ? next.occurrence : 0, ts, ts, ts, id, claimToken];
    } else {
      sql = "UPDATE reminders SET status = 'sent', claim_token = NULL, claimed_at = NULL, attempts = 0, last_attempt_at = ?, last_error = NULL, sent_at = ?, updated_at = ? WHERE id = ? AND claim_token = ?";
      binds = [ts, ts, ts, id, claimToken];
    }
    const result = await run(env, sql, binds);
    return !!(result && result.meta && result.meta.changes === 1);
  } catch (err) {
    console.error("settleReminderDelivery failed:", err.message);
    return false;
  }
}

/**
 * Persist the user's IANA timezone. The value must already have been validated
 * with `isValidTimeZone` by the caller; this only stores it.
 */
export async function setUserTimezone(env, telegramId, timezone) {
  if (!Number.isFinite(telegramId) || !timezone) return false;
  try {
    const result = await env.DB.prepare("UPDATE users SET timezone = ?, updated_at = ? WHERE telegram_id = ?")
      .bind(String(timezone).slice(0, 64), now(), telegramId).run();
    return !!(result && result.meta && result.meta.changes === 1);
  } catch (err) {
    console.error("setUserTimezone failed:", err.message);
    return false;
  }
}

/** Read the stored timezone for one user, or null when unset. */
export async function getUserTimezone(env, telegramId) {
  if (!Number.isFinite(telegramId)) return null;
  try {
    const row = await env.DB.prepare("SELECT timezone FROM users WHERE telegram_id = ?").bind(telegramId).first();
    return row && row.timezone ? row.timezone : null;
  } catch (err) {
    console.error("getUserTimezone failed:", err.message);
    return null;
  }
}
