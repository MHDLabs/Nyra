// Self-service user endpoints: profile, usage counters, the Mini App chat
// box (which runs the real provider pipeline, not a stub), the model picker
// and the coding-mode switch.
import { getUserStrict, getUserConnectionById, getEnabledUserConnections, saveThreadMessage, getThreadContext, updateUsageStatsAsync, trackConnectionUsage } from "../db.js";
import { MEMORY_UPDATE_INTERVAL } from "../config.js";
import { now } from "../utils.js";
import { tryStreamWithFallback, humanizeError } from "../ai.js";
import { buildContextMessages, getUserPersonality, incrementMessageCount, consolidateMemory } from "../memory.js";
import { jsonOk, jsonError } from "./respond.js";

/**
 * Synthetic message ids for Mini App turns.
 *
 * Mini App turns have no Telegram message, so an id has to be invented — but
 * `thread_messages` is keyed on (chat_id, message_id), and Telegram message ids
 * are always positive. The old code used `Date.now()`/`Date.now() + 1`, which
 * collides with real Telegram ids in the same private chat (readable context
 * overwritten) and with a neighbouring turn that happened in the same
 * millisecond. Negative ids are outside Telegram's range entirely, and the
 * `+1` on the assistant keeps the "user then assistant" ordering that
 * `getThreadContext`'s `ORDER BY message_id DESC` + reverse relies on once both
 * rows share the same second-resolution `created_at`.
 */
let syntheticTurnSeq = 0;
function syntheticMessageIds() {
  syntheticTurnSeq = (syntheticTurnSeq + 1) % 1000;
  const base = Date.now() * 1000 + syntheticTurnSeq;
  return { user: -(base * 2), assistant: -(base * 2) + 1 };
}

/**
 * Get user profile
 */
export async function handleUserProfile(env, userId) {
  let user;
  try {
    user = await getUserStrict(env, userId);
  } catch (err) {
    console.error("handleUserProfile failed:", err.message);
    return jsonError(500, "Database unavailable");
  }
  if (!user) return jsonError(404, "User not found");

  let activeConnection = null;
  if (user.active_connection_id) {
    activeConnection = await getUserConnectionById(env, userId, user.active_connection_id);
  }

  const personality = user.personality_id === "default" 
    ? { name: "پیش‌فرض" }
    : await env.DB.prepare("SELECT name FROM custom_personalities WHERE personality_id = ? AND telegram_id = ?")
        .bind(user.personality_id.replace("custom:", ""), userId).first();

  return jsonOk({
    telegram_id: user.telegram_id,
    first_name: user.first_name || "",
    username: user.username || null,
    memory_mode: user.memory_mode || "normal",
    personality_id: user.personality_id || "default",
    coding_mode: user.coding_mode || 0,
    active_connection: activeConnection ? {
      label: activeConnection.label,
      provider: activeConnection.provider,
      model: activeConnection.model
    } : null,
    personality: personality || { name: "پیش‌فرض" }
  });
}

/**
 * Get user statistics
 */
export async function handleUserStats(env, userId) {
  let user;
  try {
    user = await getUserStrict(env, userId);
  } catch (err) {
    return jsonError(500, "Database unavailable");
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

  return jsonOk({ total: total, success: success, fail: fail });
}

/**
 * Handle chat message from Mini App — runs the real AI pipeline for this user.
 *
 * Mirrors `handleAIMessage`: the same usage accounting, connection-usage rollup
 * and long-term memory consolidation run here. Skipping them meant Mini App
 * turns were invisible in /usage and never reached memory.
 */
export async function handleChatMessage(env, ctx, userId, message) {
  const text = (message || "").toString().trim();
  if (!text) return jsonError(400, "Empty message");

  let user;
  try {
    user = await getUserStrict(env, userId);
  } catch (err) {
    console.error("handleChatMessage user lookup failed:", err.message);
    return jsonError(500, "Database unavailable");
  }
  if (!user) return jsonError(404, "User not found");

  try {
    const personality = await getUserPersonality(env, user);
    const recent = await getThreadContext(env, userId, userId);
    const history = Array.isArray(recent) ? recent : [];
    const messages = buildContextMessages(personality, user, null, history, text, user.memory_mode || "normal");

    let reply = "";
    let usedConn = null;
    let usage = null;
    let category = null;
    for await (const event of tryStreamWithFallback(env, user, messages, { totalBudgetMs: 25000, stallTimeoutMs: 15000 })) {
      if (event.type === "text") reply += event.text;
      else if (event.type === "done") { usedConn = event.connection; usage = event.usage || null; }
      else if (event.type === "error") category = event.category;
    }

    if (!reply) {
      updateUsageStatsAsync(env, ctx, userId, false, category || "unknown", null);
      return jsonError(502, humanizeError(category || "unknown"));
    }

    const ids = syntheticMessageIds();
    await saveThreadMessage(env, userId, userId, ids.user, userId, "user", text);
    await saveThreadMessage(env, userId, userId, ids.assistant, null, "assistant", reply);

    // Accounting + memory, exactly as the Telegram path does it.
    updateUsageStatsAsync(env, ctx, userId, true, null, usage);
    if (usedConn && usedConn.connection_id) {
      const totalTokens = usage ? ((usage.in || 0) + (usage.out || 0)) : 0;
      const connId = usedConn.connection_id;
      if (ctx && ctx.waitUntil) ctx.waitUntil(trackConnectionUsage(env, connId, userId, totalTokens));
      else await trackConnectionUsage(env, connId, userId, totalTokens);
    }

    const counter = await incrementMessageCount(env, userId);
    if (counter >= MEMORY_UPDATE_INTERVAL && (user.memory_mode || "normal") !== "none") {
      const exchange = { user: text, assistant: reply };
      const fresh = await getUserStrict(env, userId).catch(function () { return user; });
      const task = consolidateMemory(env, fresh || user, history, exchange)
        .catch(function (err) { console.error("Mini App consolidateMemory failed:", err.message); });
      if (ctx && ctx.waitUntil) ctx.waitUntil(task);
      else await task;
    }

    return jsonOk({ response: reply, connection: usedConn ? { label: usedConn.label, model: usedConn.model } : null });
  } catch (err) {
    console.error("handleChatMessage failed:", err.message);
    updateUsageStatsAsync(env, ctx, userId, false, "exception", null);
    return jsonError(500, "Chat failed");
  }
}

/** List the user's available models and the active one. */
export async function handleUserConnections(env, userId) {
  try {
    const user = await getUserStrict(env, userId);
    const conns = await getEnabledUserConnections(env, userId);
    const list = conns.map(function (c) {
      return { connection_id: c.connection_id, label: c.label, provider: c.provider, model: c.model, is_global: c.is_global, is_fast: c.is_fast, supports_vision: c.supports_vision, active: user && user.active_connection_id === c.connection_id };
    });
    return jsonOk({ connections: list, active_connection_id: user ? user.active_connection_id : null });
  } catch (err) { return jsonError(500, "Failed to load connections"); }
}

/** Set the user's active connection. */
export async function handleSetActiveConnection(env, userId, connectionId) {
  try {
    const conn = await getUserConnectionById(env, userId, connectionId);
    if (!conn || conn.enabled !== 1) return jsonError(404, "Connection not found");
    if (conn.is_global !== 1 && conn.telegram_id !== userId) return jsonError(403, "Not allowed");
    await env.DB.prepare("UPDATE users SET active_connection_id = ?, active_route_id = NULL, updated_at = ? WHERE telegram_id = ?").bind(connectionId, now(), userId).run();
    return jsonOk({ success: true, active_connection_id: connectionId });
  } catch (err) { return jsonError(500, "Failed to set active connection"); }
}

/**
 * Handle toggle coding mode
 */
export async function handleToggleCodingMode(env, userId, enabled) {
  try {
    const codingMode = enabled ? 1 : 0;
    await env.DB.prepare(
      "UPDATE users SET coding_mode = ?, updated_at = ? WHERE telegram_id = ?"
    ).bind(codingMode, now(), userId).run();

    return jsonOk({ success: true, coding_mode: codingMode });
  } catch (err) {
    return jsonError(500, "Failed to toggle coding mode");
  }
}
