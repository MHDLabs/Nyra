// Users, chats, thread history, block list and per-user conversation flow state.
import { FLOW_TTL, MAX_CONTEXT_MESSAGES, USER_LAST_SEEN_INTERVAL } from "../config.js";
import { containsNyraWord, escapeRegex, isAdmin, now, truncate } from "../utils.js";

export async function getUser(env, userId) {
  try { return await env.DB.prepare("SELECT * FROM users WHERE telegram_id = ?").bind(userId).first(); }
  catch (err) { console.error("getUser failed:", err.message); return null; }
}

export async function upsertUser(env, from) {
  const ts = now();
  const existing = await getUser(env, from.id);
  if (!existing) {
    try {
      await env.DB.prepare("INSERT INTO users (telegram_id, first_name, last_name, username, language_code, personality_id, memory_mode, memory_data, usage_stats, fallback_enabled, msg_counter, active_connection_id, created_at, last_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, 'default', 'normal', '{}', '{}', 1, 0, NULL, ?, ?, ?) ON CONFLICT(telegram_id) DO NOTHING")
        .bind(from.id, from.first_name || "", from.last_name || "", from.username || "", from.language_code || "", ts, ts, ts).run();
    } catch (err) { console.error("upsertUser insert failed:", err.message); }
    return await getUser(env, from.id);
  }
  const nameChanged = existing.first_name !== (from.first_name || "") || existing.last_name !== (from.last_name || "") || existing.username !== (from.username || "") || existing.language_code !== (from.language_code || "");
  const lastSeenOld = (ts - (existing.last_seen_at || 0)) > USER_LAST_SEEN_INTERVAL;
  if (!nameChanged && !lastSeenOld) return existing;
  try {
    if (nameChanged) {
      await env.DB.prepare("UPDATE users SET first_name = ?, last_name = ?, username = ?, language_code = ?, last_seen_at = ?, updated_at = ? WHERE telegram_id = ?")
        .bind(from.first_name || "", from.last_name || "", from.username || "", from.language_code || "", ts, ts, from.id).run();
    } else {
      await env.DB.prepare("UPDATE users SET last_seen_at = ? WHERE telegram_id = ?").bind(ts, from.id).run();
    }
  } catch (err) {}
  return await getUser(env, from.id);
}

export async function getChat(env, chatId) {
  try { return await env.DB.prepare("SELECT * FROM chats WHERE chat_id = ?").bind(chatId).first(); }
  catch (err) { return null; }
}

export async function recordGroupChatAndCheckAccess(env, chat, userId) {
  const ts = now();
  const existing = await getChat(env, chat.id);
  if (!existing) {
    try {
      await env.DB.prepare("INSERT INTO chats (chat_id, chat_type, title, enabled, mode, summary, created_at, updated_at) VALUES (?, ?, ?, 0, 'disabled', '', ?, ?) ON CONFLICT(chat_id) DO NOTHING")
        .bind(chat.id, chat.type || "group", chat.title || "", ts, ts).run();
    } catch (err) {}
    return false;
  }
  if (existing.title !== (chat.title || "")) {
    try { await env.DB.prepare("UPDATE chats SET title = ?, updated_at = ? WHERE chat_id = ?").bind(chat.title || "", ts, chat.id).run(); } catch (err) {}
  }
  const mode = existing.mode || (existing.enabled === 1 ? "enabled" : "disabled");
  if (mode === "disabled") return false;
  if (mode === "admin_only") return isAdmin(env, userId);
  return mode === "enabled";
}

export async function isUserBlocked(env, userId) {
  try {
    const row = await env.DB.prepare("SELECT telegram_id FROM blocked_users WHERE telegram_id = ?").bind(userId).first();
    return !!row;
  } catch (err) { return false; }
}

export async function saveThreadMessage(env, chatId, threadId, messageId, userId, role, content) {
  try {
    await env.DB.prepare(
      "INSERT INTO thread_messages (chat_id, message_id, thread_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, message_id) DO UPDATE SET thread_id = excluded.thread_id, content = excluded.content"
    ).bind(chatId, messageId, threadId, userId || null, role, truncate(content || "", 2000), now()).run();
  } catch (err) { console.error("saveThreadMessage failed:", err.message); }
}

export async function getThreadContext(env, chatId, threadId) {
  try {
    const result = await env.DB.prepare(
      "SELECT tm.role, tm.content, tm.user_id, COALESCE(NULLIF(u.first_name, ''), NULLIF(u.username, ''), CAST(tm.user_id AS TEXT)) AS user_name FROM thread_messages tm LEFT JOIN users u ON u.telegram_id = tm.user_id WHERE tm.chat_id = ? AND tm.thread_id = ? ORDER BY tm.created_at DESC, tm.message_id DESC LIMIT ?"
    ).bind(chatId, threadId, MAX_CONTEXT_MESSAGES).all();
    const rows = result.results || [];
    return rows.reverse();
  } catch (err) { return []; }
}

function isReplyToBot(message, identity) {
  if (!message || !message.reply_to_message) return false;
  if (!message.reply_to_message.from) return false;
  if (!identity || !identity.id) return false;
  return message.reply_to_message.from.id === identity.id;
}

export function isGroupTrigger(message, identity) {
  if (!message) return { trigger: false, mode: null };
  if (isReplyToBot(message, identity)) {
    return { trigger: true, mode: "reply" };
  }
  const text = (message.text || message.caption || "");
  if (!text) return { trigger: false, mode: null };
  if (containsNyraWord(text)) return { trigger: true, mode: "call" };
  if (identity && identity.username) {
    const pattern = new RegExp("@" + escapeRegex(identity.username), "i");
    if (pattern.test(text)) return { trigger: true, mode: "call" };
  }
  return { trigger: false, mode: null };
}

export async function determineThreadId(env, chatId, message, identity, triggerMode) {
  if (triggerMode === "reply" && isReplyToBot(message, identity)) {
    const replyMsgId = message.reply_to_message.message_id;
    try {
      const row = await env.DB.prepare("SELECT thread_id FROM thread_messages WHERE chat_id = ? AND message_id = ?").bind(chatId, replyMsgId).first();
      if (row && row.thread_id) return row.thread_id;
    } catch (err) {}
    return replyMsgId;
  }
  return message.message_id;
}

export async function getFlowState(env, userId) {
  try { return await env.KV.get("flow:" + userId, "json"); } catch (err) { return null; }
}

export async function setFlowState(env, userId, state) {
  try { await env.KV.put("flow:" + userId, JSON.stringify(state), { expirationTtl: FLOW_TTL }); }
  catch (err) { console.error("setFlowState failed:", err.message); }
}

export async function clearFlowState(env, userId) {
  try { await env.KV.delete("flow:" + userId); } catch (err) {}
}
