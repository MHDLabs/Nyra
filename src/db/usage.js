// Per-user request/token accounting and per-connection usage rollups.
import { now } from "../utils.js";
import { getUser } from "./users.js";

/**
 * Track connection usage (tokens and requests)
 */
export async function trackConnectionUsage(env, connectionId, telegramId, tokensUsed = 0) {
  try {
    const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    await env.DB.prepare(`
      INSERT INTO connection_usage (connection_id, telegram_id, tokens_used, requests_count, date)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(connection_id, telegram_id, date)
      DO UPDATE SET 
        tokens_used = tokens_used + excluded.tokens_used,
        requests_count = requests_count + excluded.requests_count
    `).bind(connectionId, telegramId, tokensUsed, date).run();
  } catch (err) {
    console.error("Connection usage tracking failed:", err.message);
  }
}

/**
 * Get connection usage stats by connection
 */
export async function getConnectionUsageStats(env, connectionId, days = 7) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoff = cutoffDate.toISOString().split("T")[0];

    const result = await env.DB.prepare(`
      SELECT 
        connection_id,
        SUM(tokens_used) as total_tokens,
        SUM(requests_count) as total_requests,
        COUNT(DISTINCT telegram_id) as unique_users,
        COUNT(DISTINCT date) as active_days
      FROM connection_usage
      WHERE connection_id = ? AND date >= ?
      GROUP BY connection_id
    `).bind(connectionId, cutoff).first();

    return result || { total_tokens: 0, total_requests: 0, unique_users: 0, active_days: 0 };
  } catch (err) {
    console.error("Get connection usage stats failed:", err.message);
    return { total_tokens: 0, total_requests: 0, unique_users: 0, active_days: 0 };
  }
}

/**
 * Get all connection usage summary for admin
 */
export async function getAllConnectionUsageStats(env, days = 7) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoff = cutoffDate.toISOString().split("T")[0];

    const result = await env.DB.prepare(`
      SELECT 
        cu.connection_id,
        ac.label,
        ac.provider,
        ac.model,
        SUM(cu.tokens_used) as total_tokens,
        SUM(cu.requests_count) as total_requests,
        COUNT(DISTINCT cu.telegram_id) as unique_users,
        COUNT(DISTINCT cu.date) as active_days
      FROM connection_usage cu
      LEFT JOIN ai_connections ac ON cu.connection_id = ac.connection_id
      WHERE cu.date >= ?
      GROUP BY cu.connection_id, ac.label, ac.provider, ac.model
      ORDER BY total_requests DESC
    `).bind(cutoff).all();

    return result.results || [];
  } catch (err) {
    console.error("Get all connection usage stats failed:", err.message);
    return [];
  }
}

export function parseUsageStats(raw) {
  const empty = { total: 0, success: 0, fail: 0, last_at: 0, last_error: null, in_tokens: 0, out_tokens: 0, cost_usd: 0, token_source: "unavailable" };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return empty;
    return {
      total: parsed.total || 0, success: parsed.success || 0, fail: parsed.fail || 0,
      last_at: parsed.last_at || 0, last_error: parsed.last_error || null,
      in_tokens: parsed.in_tokens || 0, out_tokens: parsed.out_tokens || 0,
      cost_usd: parsed.cost_usd || 0, token_source: parsed.token_source || "unavailable"
    };
  } catch (err) { return empty; }
}

async function updateUsageStats(env, userId, success, errorCategory, usage) {
  const user = await getUser(env, userId);
  if (!user) return;
  const stats = parseUsageStats(user.usage_stats);
  stats.total += 1;
  if (success) { stats.success += 1; stats.last_error = null; }
  else { stats.fail += 1; stats.last_error = errorCategory || "unknown"; }
  stats.last_at = now();
  if (usage && usage.source === "provider_reported") {
    stats.in_tokens = (stats.in_tokens || 0) + (usage.in || 0);
    stats.out_tokens = (stats.out_tokens || 0) + (usage.out || 0);
    stats.token_source = "provider_reported";
  }
  if (usage && usage.cost && typeof usage.cost === "number" && usage.cost > 0) {
    stats.cost_usd = (stats.cost_usd || 0) + usage.cost;
  }
  try { await env.DB.prepare("UPDATE users SET usage_stats = ? WHERE telegram_id = ?").bind(JSON.stringify(stats), userId).run(); }
  catch (err) { console.error("updateUsageStats failed:", err.message); }
}

export function updateUsageStatsAsync(env, ctx, userId, success, errorCategory, usage) {
  if (ctx && ctx.waitUntil) ctx.waitUntil(updateUsageStats(env, userId, success, errorCategory, usage));
  else updateUsageStats(env, userId, success, errorCategory, usage).catch(function () {});
}
