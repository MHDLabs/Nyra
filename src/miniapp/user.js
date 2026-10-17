// Self-service user endpoints: profile, usage counters, the Mini App chat
// box (which runs the real provider pipeline, not a stub), the model picker
// and the coding-mode switch.
import { getUser, getUserConnectionById, getEnabledUserConnections, saveThreadMessage, getThreadContext } from "../db.js";
import { now } from "../utils.js";
import { tryStreamWithFallback, humanizeError } from "../ai.js";
import { buildContextMessages, getUserPersonality } from "../memory.js";
import { jsonOk, jsonError } from "./respond.js";

/**
 * Get user profile
 */
export async function handleUserProfile(env, userId) {
  const user = await getUser(env, userId);
  if (!user) {
    return new Response(JSON.stringify({ error: "User not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  let activeConnection = null;
  if (user.active_connection_id) {
    activeConnection = await getUserConnectionById(env, userId, user.active_connection_id);
  }

  const personality = user.personality_id === "default" 
    ? { name: "پیش‌فرض" }
    : await env.DB.prepare("SELECT name FROM custom_personalities WHERE personality_id = ? AND telegram_id = ?")
        .bind(user.personality_id.replace("custom:", ""), userId).first();

  return new Response(JSON.stringify({
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
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * Get user statistics
 */
export async function handleUserStats(env, userId) {
  const user = await getUser(env, userId);
  let total = 0, success = 0, fail = 0;
  if (user && user.usage_stats) {
    try {
      const stats = JSON.parse(user.usage_stats);
      total = stats.total || 0;
      success = stats.success || 0;
      fail = stats.fail || 0;
    } catch (e) {}
  }

  return new Response(JSON.stringify({
    total: total,
    success: success,
    fail: fail
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * Handle chat message from Mini App — runs the real AI pipeline for this user.
 */
export async function handleChatMessage(env, userId, message) {
  const text = (message || "").toString().trim();
  if (!text) {
    return new Response(JSON.stringify({ error: "Empty message" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  try {
    const user = await getUser(env, userId);
    if (!user) return jsonError(404, "User not found");
    const personality = await getUserPersonality(env, user);
    const recent = await getThreadContext(env, userId, userId);
    const messages = buildContextMessages(personality, user, null, Array.isArray(recent) ? recent : [], text, user.memory_mode || "normal");
    let reply = "";
    let usedConn = null;
    let category = null;
    for await (const event of tryStreamWithFallback(env, user, messages, { totalBudgetMs: 25000, stallTimeoutMs: 15000 })) {
      if (event.type === "text") reply += event.text;
      else if (event.type === "done") usedConn = event.connection;
      else if (event.type === "error") category = event.category;
    }
    if (!reply) {
      return jsonError(502, humanizeError(category || "unknown"));
    }
    try {
      await saveThreadMessage(env, userId, userId, Date.now(), userId, "user", text);
      await saveThreadMessage(env, userId, userId, Date.now() + 1, userId, "assistant", reply);
    } catch (e) {}
    return jsonOk({ response: reply, connection: usedConn ? { label: usedConn.label, model: usedConn.model } : null });
  } catch (err) {
    console.error("handleChatMessage failed:", err.message);
    return jsonError(500, "Chat failed");
  }
}

/** List the user's available models and the active one. */
export async function handleUserConnections(env, userId) {
  try {
    const user = await getUser(env, userId);
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

    return new Response(JSON.stringify({ success: true, coding_mode: codingMode }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
