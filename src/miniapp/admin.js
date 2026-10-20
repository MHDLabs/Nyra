// Admin panel endpoints: site stats, user/chat pagination, global settings
// and per-connection usage metrics. Reachability is enforced once, in the
// router, before any of these run.
import { getAllConnectionUsageStats, setSetting, isPersonalModelsAllowed, getPersonalModelLimit, getWorkersAIPolicy, setWorkersAIPolicy, getWorkersAIModel, setWorkersAIModel } from "../db.js";
import { jsonOk, jsonError } from "./respond.js";

/**
 * Get admin statistics
 */
export async function handleAdminStats(env) {
  const [users, chats, connections, usageRow] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as count FROM users").first(),
    env.DB.prepare("SELECT COUNT(*) as count FROM chats WHERE enabled = 1").first(),
    env.DB.prepare("SELECT COUNT(*) as count FROM ai_connections WHERE enabled = 1").first(),
    env.DB.prepare("SELECT SUM(request_count) as total_reqs FROM connection_usage").first().catch(() => ({ total_reqs: 0 }))
  ]);

  return jsonOk({
    users: users?.count || 0,
    chats: chats?.count || 0,
    requests: usageRow?.total_reqs || 0,
    connections: connections?.count || 0
  });
}

/**
 * Get admin users list
 */
export async function handleAdminUsers(env, page = 0, limit = 50) {
  const offset = page * limit;
  const users = await env.DB.prepare(`
    SELECT 
      telegram_id, 
      first_name, 
      username, 
      created_at,
      msg_counter as request_count
    FROM users 
    ORDER BY created_at DESC 
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();

  const total = await env.DB.prepare("SELECT COUNT(*) as count FROM users").first();

  return jsonOk({
    users: users.results || [],
    total: total?.count || 0,
    page: page,
    hasMore: (offset + limit) < (total?.count || 0)
  });
}

/**
 * Get admin chats list
 */
export async function handleAdminChats(env, page = 0, limit = 50) {
  const offset = page * limit;
  const chats = await env.DB.prepare(`
    SELECT 
      chat_id, 
      title, 
      chat_type, 
      enabled,
      mode,
      created_at
    FROM chats 
    ORDER BY created_at DESC 
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();

  const total = await env.DB.prepare("SELECT COUNT(*) as count FROM chats").first();

  return jsonOk({
    chats: chats.results || [],
    total: total?.count || 0,
    page: page,
    hasMore: (offset + limit) < (total?.count || 0)
  });
}

/** Admin settings: read global toggles. */
export async function handleAdminSettings(env) {
  try {
    const allow = await isPersonalModelsAllowed(env);
    const limit = await getPersonalModelLimit(env);
    return jsonOk({ allow_personal_models: allow, personal_model_limit: limit, workers_ai_policy: await getWorkersAIPolicy(env), workers_ai_model: await getWorkersAIModel(env), workers_ai_available: !!env.AI });
  } catch (err) { return jsonError(500, "Failed to load settings"); }
}

/** Admin settings: update a global toggle. */
export async function handleAdminUpdateSettings(env, userId, body) {
  try {
    if (body && body.allow_personal_models !== undefined) {
      const ok = await setSetting(env, "allow_personal_models", body.allow_personal_models ? "1" : "0", userId);
      if (!ok) return jsonError(500, "Failed to save settings");
    }
    if (body && body.personal_model_limit !== undefined) {
      const n = parseInt(body.personal_model_limit, 10);
      if (!Number.isFinite(n) || n < 1 || n > 100) return jsonError(400, "Personal model limit must be between 1 and 100");
      const ok = await setSetting(env, "personal_model_limit", String(n), userId);
      if (!ok) return jsonError(500, "Failed to save settings");
    }
    if (body && body.workers_ai_policy !== undefined) {
      const ok = await setWorkersAIPolicy(env, String(body.workers_ai_policy), userId);
      if (!ok) return jsonError(400, "Invalid or unsaved Workers AI policy");
    }
    if (body && body.workers_ai_model !== undefined) {
      const ok = await setWorkersAIModel(env, body.workers_ai_model, userId);
      if (!ok) return jsonError(400, "Workers AI model must be a valid @cf/... model ID");
    }
    return await handleAdminSettings(env);
  } catch (err) { return jsonError(500, "Failed to update settings"); }
}

/**
 * Handle admin connection usage stats
 */
export async function handleAdminConnectionUsage(env, days = 7) {
  try {
    const stats = await getAllConnectionUsageStats(env, days);
    return jsonOk({ stats, days });
  } catch (err) {
    return jsonError(500, err.message || "Failed to load connection usage");
  }
}
