// Shared service: the admin-provided global connections.
//
// A global connection (`ai_connections.is_global = 1`) is paid for by the
// operator, so using one is a shared service with its own kill switch and
// per-user daily quotas. Enforcement lives here and is called from the AI
// request path itself (Telegram handler and Mini App chat), never from the UI:
// a client cannot bypass a quota by skipping a render step.
//
// Counters live in `shared_service_usage`, keyed by (telegram_id, UTC date).
// The increment is a single conditional UPDATE, so two concurrent requests
// cannot both slip past the last remaining unit of quota.
import {
  SETTING_SHARED_SERVICE_ENABLED, SETTING_SHARED_REQUEST_LIMIT, SETTING_SHARED_TOKEN_LIMIT,
  DEFAULT_SHARED_REQUEST_LIMIT, DEFAULT_SHARED_TOKEN_LIMIT
} from "../config.js";
import { getSetting } from "./settings.js";
import { countEnabledSharedConnections } from "./connections.js";

export function todayUTC() {
  return new Date().toISOString().split("T")[0];
}

/** True when this connection is the operator's, not the caller's own key. */
export function isSharedConnection(connection, userId) {
  if (!connection) return false;
  if (connection.is_global !== 1) return false;
  return Number(connection.telegram_id) !== Number(userId);
}

function quota(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function getSharedQuotas(env) {
  const enabledRaw = await getSetting(env, SETTING_SHARED_SERVICE_ENABLED, "0");
  return {
    enabled: enabledRaw === "1" || enabledRaw === "true",
    requestLimit: quota(await getSetting(env, SETTING_SHARED_REQUEST_LIMIT, String(DEFAULT_SHARED_REQUEST_LIMIT)), DEFAULT_SHARED_REQUEST_LIMIT),
    tokenLimit: quota(await getSetting(env, SETTING_SHARED_TOKEN_LIMIT, String(DEFAULT_SHARED_TOKEN_LIMIT)), DEFAULT_SHARED_TOKEN_LIMIT)
  };
}

export async function getSharedUsage(env, userId, date) {
  try {
    const row = await env.DB.prepare("SELECT requests_count, tokens_used FROM shared_service_usage WHERE telegram_id = ? AND date = ?").bind(userId, date || todayUTC()).first();
    return { requests: row ? row.requests_count : 0, tokens: row ? row.tokens_used : 0 };
  } catch (err) { return { requests: 0, tokens: 0 }; }
}

/**
 * Consume one request unit of the caller's daily allowance.
 *
 * Returns `{ allowed: true }` when the request may proceed, otherwise
 * `{ allowed: false, reason, quota, used }`. A request limit of 0 means
 * unlimited; the token limit is checked against consumption so far because the
 * cost of the current request is not known yet (it is added afterwards by
 * `recordSharedTokenUsage`).
 */
export async function reserveSharedRequest(env, userId, connection) {
  if (!isSharedConnection(connection, userId)) return { allowed: true, shared: false };
  const q = await getSharedQuotas(env);
  if (!q.enabled) return { allowed: false, shared: true, reason: "shared_service_disabled", quota: 0, used: 0 };
  // The switch being on is not the same as the service working. With no enabled
  // shared model there is nothing to route to, and saying "disabled by the
  // administrator" here would be a lie that sends the user hunting for a key
  // they do not need.
  if ((await countEnabledSharedConnections(env)) === 0) {
    return { allowed: false, shared: true, reason: "shared_model_unavailable", quota: 0, used: 0 };
  }
  const date = todayUTC();
  try {
    // Seed the row so the conditional UPDATE always has a target.
    await env.DB.prepare("INSERT INTO shared_service_usage (telegram_id, date, requests_count, tokens_used) VALUES (?, ?, 0, 0) ON CONFLICT(telegram_id, date) DO NOTHING").bind(userId, date).run();
    // Atomic check-and-increment. `requestLimit = 0` disables the request cap;
    // `meta.changes` tells us whether the row was actually incremented, so two
    // concurrent requests cannot both take the last remaining unit.
    const res = await env.DB.prepare(
      "UPDATE shared_service_usage SET requests_count = requests_count + 1 WHERE telegram_id = ? AND date = ? AND (? = 0 OR requests_count < ?)"
    ).bind(userId, date, q.requestLimit, q.requestLimit).run();
    const changed = res && res.meta ? res.meta.changes : 0;
    const used = await getSharedUsage(env, userId, date);
    if (!changed) {
      return { allowed: false, shared: true, reason: "shared_request_quota_exceeded", quota: q.requestLimit, used: used.requests };
    }
    if (q.tokenLimit > 0 && used.tokens >= q.tokenLimit) {
      // Already over the token allowance: refuse, and hand the reserved unit back
      // so it is not lost to a request that never ran.
      await env.DB.prepare("UPDATE shared_service_usage SET requests_count = MAX(requests_count - 1, 0) WHERE telegram_id = ? AND date = ?").bind(userId, date).run();
      return { allowed: false, shared: true, reason: "shared_token_quota_exceeded", quota: q.tokenLimit, used: used.tokens };
    }
    return { allowed: true, shared: true, used: used.requests, quota: q.requestLimit, tokenLimit: q.tokenLimit };
  } catch (err) {
    console.error("reserveSharedRequest failed:", err.message);
    // Fail closed: an unreadable quota table must not hand out free operator credit.
    return { allowed: false, shared: true, reason: "shared_quota_unavailable", quota: 0, used: 0 };
  }
}

/**
 * Hand back a reserved request unit when the turn failed before the provider
 * produced anything. Without this, an outage on the operator's side burns the
 * user's daily allowance for an answer they never received.
 */
export async function releaseSharedRequest(env, userId) {
  try {
    await env.DB.prepare("UPDATE shared_service_usage SET requests_count = MAX(requests_count - 1, 0) WHERE telegram_id = ? AND date = ?").bind(userId, todayUTC()).run();
  } catch (err) { console.error("releaseSharedRequest failed:", err.message); }
}

/** Add the measured token cost of a completed shared-service request. */
export async function recordSharedTokenUsage(env, userId, tokens) {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return;
  try {
    const date = todayUTC();
    await env.DB.prepare("INSERT INTO shared_service_usage (telegram_id, date, requests_count, tokens_used) VALUES (?, ?, 0, ?) ON CONFLICT(telegram_id, date) DO UPDATE SET tokens_used = tokens_used + excluded.tokens_used").bind(userId, date, n).run();
  } catch (err) { console.error("recordSharedTokenUsage failed:", err.message); }
}

/** Per-user shared-service consumption for the admin panel. */
export async function getSharedUsageReport(env, days = 7) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoff = cutoffDate.toISOString().split("T")[0];
    const result = await env.DB.prepare(
      "SELECT s.telegram_id, COALESCE(NULLIF(u.first_name, ''), NULLIF(u.username, ''), CAST(s.telegram_id AS TEXT)) AS user_name, SUM(s.requests_count) AS total_requests, SUM(s.tokens_used) AS total_tokens, COUNT(DISTINCT s.date) AS active_days FROM shared_service_usage s LEFT JOIN users u ON u.telegram_id = s.telegram_id WHERE s.date >= ? GROUP BY s.telegram_id ORDER BY total_requests DESC"
    ).bind(cutoff).all();
    return result.results || [];
  } catch (err) {
    console.error("getSharedUsageReport failed:", err.message);
    return [];
  }
}

/** Persian/English user-facing text for a refused shared-service request. */
export function sharedQuotaMessage(reason, used, quota) {
  if (reason === "shared_service_disabled") {
    return "⚠ The shared service is currently disabled by the administrator. Add your own API key to keep chatting.";
  }
  if (reason === "shared_token_quota_exceeded") {
    return "⚠ Your daily shared-service token allowance is used up (" + used + " / " + quota + "). It resets at 00:00 UTC. Add your own API key for unlimited use.";
  }
  if (reason === "shared_model_unavailable") {
    return "⚠ No shared model is configured right now. Ask the administrator to add one, or add your own API key from Settings → My Personal Models.";
  }
  if (reason === "shared_quota_unavailable") {
    return "⚠ Could not verify your shared-service quota right now. Please try again in a moment.";
  }
  return "⚠ Your daily shared-service limit is reached (" + used + " / " + quota + "). It resets at 00:00 UTC. Add your own API key for unlimited use.";
}
