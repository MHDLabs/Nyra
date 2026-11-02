// Self-service user endpoints: profile, usage counters, the model picker and
// the coding-mode switch.
//
// The Mini App is a management surface only; actual chat processing stays in
// src/handlers/* and runs from Telegram. There is deliberately no chat handler
// here anymore (the old /api/chat endpoint is gone).
import { getUserStrict } from "../db/users.js";
import { getUserConnectionById, getEnabledUserConnections } from "../db/connections.js";
import { getSharedQuotas, getSharedUsage, todayUTC } from "../db/shared-service.js";
import { localeForUser, t } from "../i18n/index.js";
import { now } from "../utils.js";
import { jsonOk, jsonError } from "./respond.js";

/** Locale lookup that never throws: user rows may be unavailable mid-outage. */
async function userLocale(env, userId) {
  try {
    const row = await getUserStrict(env, userId);
    return localeForUser(row);
  } catch (err) {
    return localeForUser(null);
  }
}

/**
 * Get user profile
 */
export async function handleUserProfile(env, userId) {
  const locale = await userLocale(env, userId);
  let user;
  try {
    user = await getUserStrict(env, userId);
  } catch (err) {
    console.error("handleUserProfile failed:", err.message);
    return jsonError(500, t(locale, "common.database_unavailable"));
  }
  if (!user) return jsonError(404, t(locale, "common.not_found"));

  let activeConnection = null;
  if (user.active_connection_id) {
    activeConnection = await getUserConnectionById(env, userId, user.active_connection_id);
  }

  let personality = null;
  if (String(user.personality_id || "default").startsWith("custom:")) {
    personality = await env.DB.prepare("SELECT name FROM custom_personalities WHERE personality_id = ? AND telegram_id = ? AND enabled = 1")
      .bind(user.personality_id.slice("custom:".length), userId).first();
  } else {
    personality = await env.DB.prepare("SELECT name FROM personalities WHERE personality_id = ? AND enabled = 1")
      .bind(user.personality_id || "default").first();
  }

  return jsonOk({
    telegram_id: user.telegram_id,
    first_name: user.first_name || "",
    username: user.username || null,
    preferred_name: user.preferred_name || null,
    locale: localeForUser(user),
    memory_mode: user.memory_mode || "normal",
    personality_id: user.personality_id || "default",
    coding_mode: user.coding_mode || 0,
    has_custom_instructions: !!user.custom_instructions,
    onboarding_completed: user.onboarding_completed ? 1 : 0,
    active_connection: activeConnection ? {
      label: activeConnection.label,
      provider: activeConnection.provider,
      model: activeConnection.model
    } : null,
    personality: personality || { name: t(locale, "prefs.default_personality") }
  });
}

/**
 * Get user statistics plus the shared-service daily allowance. The stats shape
 * stays backward compatible; `shared` is additive so older clients ignore it.
 */
export async function handleUserStats(env, userId) {
  const locale = await userLocale(env, userId);
  let user;
  try {
    user = await getUserStrict(env, userId);
  } catch (err) {
    return jsonError(500, t(locale, "common.database_unavailable"));
  }
  let total = 0, success = 0, fail = 0;
  if (user && user.usage_stats) {
    try {
      const stats = JSON.parse(user.usage_stats);
      total = stats.total || 0;
      success = stats.success || 0;
      fail = stats.fail || 0;
    } catch (e) {}
  }

  const date = todayUTC();
  const [quotas, usage] = await Promise.all([
    getSharedQuotas(env).catch(function () { return null; }),
    getSharedUsage(env, userId, date).catch(function () { return { requests: 0, tokens: 0 }; })
  ]);
  return jsonOk({
    total: total,
    success: success,
    fail: fail,
    usage_date: date,
    shared: {
      enabled: !!(quotas && quotas.enabled),
      request_limit: quotas ? quotas.requestLimit : 0,
      token_limit: quotas ? quotas.tokenLimit : 0,
      used_requests: usage.requests,
      used_tokens: usage.tokens
    }
  });
}

/** List the user's available models and the active one. */
export async function handleUserConnections(env, userId) {
  const locale = await userLocale(env, userId);
  try {
    const user = await getUserStrict(env, userId);
    const conns = await getEnabledUserConnections(env, userId);
    const list = conns.map(function (c) {
      return { connection_id: c.connection_id, label: c.label, provider: c.provider, model: c.model, is_global: c.is_global, is_fast: c.is_fast, supports_vision: c.supports_vision, active: user && user.active_connection_id === c.connection_id };
    });
    return jsonOk({ connections: list, active_connection_id: user ? user.active_connection_id : null });
  } catch (err) {
    return jsonError(500, t(locale, "common.database_unavailable"));
  }
}

/** Set the user's active connection. */
export async function handleSetActiveConnection(env, userId, connectionId) {
  const locale = await userLocale(env, userId);
  try {
    const conn = await getUserConnectionById(env, userId, connectionId);
    if (!conn || conn.enabled !== 1) return jsonError(404, t(locale, "common.not_found"));
    if (conn.is_global !== 1 && conn.telegram_id !== userId) return jsonError(403, t(locale, "common.forbidden"));
    await env.DB.prepare("UPDATE users SET active_connection_id = ?, active_route_id = NULL, updated_at = ? WHERE telegram_id = ?").bind(connectionId, now(), userId).run();
    return jsonOk({ success: true, active_connection_id: connectionId });
  } catch (err) {
    return jsonError(500, t(locale, "common.database_unavailable"));
  }
}

/**
 * Handle toggle coding mode
 */
export async function handleToggleCodingMode(env, userId, enabled) {
  const locale = await userLocale(env, userId);
  try {
    const codingMode = enabled ? 1 : 0;
    await env.DB.prepare(
      "UPDATE users SET coding_mode = ?, updated_at = ? WHERE telegram_id = ?"
    ).bind(codingMode, now(), userId).run();

    return jsonOk({ success: true, coding_mode: codingMode });
  } catch (err) {
    return jsonError(500, t(locale, "common.database_unavailable"));
  }
}
