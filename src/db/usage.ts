import type { NyraEnv } from "../../types/env.js";
// Per-user request and token accounting.
import { now } from "../utils.js";
import { getUser } from "./users.js";

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

async function updateUsageStats(env: NyraEnv, userId, success, errorCategory, usage) {
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
  catch (err) { console.error("updateUsageStats failed:", (err instanceof Error ? err.message : String(err))); }
}

export function updateUsageStatsAsync(env: NyraEnv, ctx, userId, success, errorCategory, usage) {
  if (ctx && ctx.waitUntil) ctx.waitUntil(updateUsageStats(env, userId, success, errorCategory, usage));
  else updateUsageStats(env, userId, success, errorCategory, usage).catch(function () {});
}
