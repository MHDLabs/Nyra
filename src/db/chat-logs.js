// Durable chat archival for the admin panel (separate from short-lived thread_messages).
import { now } from "../utils.js";

const MAX_CONTENT = 8000;

function clip(text) {
  const s = String(text == null ? "" : text);
  if (s.length <= MAX_CONTENT) return s;
  return s.slice(0, MAX_CONTENT);
}

/**
 * Append one archived message. Failures are logged and never thrown.
 */
export async function logChatMessage(env, entry) {
  if (!env || !env.DB || !entry) return;
  const chatId = Number(entry.chat_id);
  if (!Number.isFinite(chatId)) return;
  const role = entry.role === "assistant" || entry.role === "system" ? entry.role : "user";
  const chatType = entry.chat_type === "group" || entry.chat_type === "supergroup" || entry.chat_type === "channel"
    ? entry.chat_type
    : "private";
  const content = clip(entry.content);
  if (!content && !entry.media_type) return;
  try {
    await env.DB.prepare(
      "INSERT INTO chat_logs (chat_id, chat_type, message_id, user_id, role, content, media_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      chatId,
      chatType,
      entry.message_id != null ? Number(entry.message_id) : null,
      entry.user_id != null ? Number(entry.user_id) : null,
      role,
      content || ("[" + (entry.media_type || "media") + "]"),
      entry.media_type || null,
      Number.isFinite(entry.created_at) ? entry.created_at : now()
    ).run();
  } catch (err) {
    console.error("logChatMessage failed:", err.message);
  }
}

export async function listPrivateChatUsers(env, options) {
  const opts = options || {};
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const q = String(opts.q || "").trim();
  try {
    // LEFT JOIN pre-aggregate avoids 2 correlated subqueries per user row.
    const base =
      "SELECT u.telegram_id, u.first_name, u.last_name, u.username, u.preferred_name, u.locale, u.language_code, " +
      "u.personality_id, u.memory_mode, u.active_connection_id, u.last_seen_at, u.last_inbound_at, u.created_at, u.msg_counter, " +
      "IFNULL(lg.log_count, 0) AS log_count, lg.last_log_at AS last_log_at " +
      "FROM users u LEFT JOIN (" +
      "SELECT chat_id, COUNT(*) AS log_count, MAX(created_at) AS last_log_at FROM chat_logs GROUP BY chat_id" +
      ") lg ON lg.chat_id = u.telegram_id ";
    if (q) {
      const like = "%" + q.replace(/%/g, "") + "%";
      const res = await env.DB.prepare(
        base +
        "WHERE CAST(u.telegram_id AS TEXT) LIKE ? OR IFNULL(u.username,'') LIKE ? OR IFNULL(u.first_name,'') LIKE ? OR IFNULL(u.preferred_name,'') LIKE ? " +
        "ORDER BY COALESCE(lg.last_log_at, u.last_seen_at, 0) DESC LIMIT ? OFFSET ?"
      ).bind(like, like, like, like, limit, offset).all();
      return res.results || [];
    }
    const res = await env.DB.prepare(
      base + "ORDER BY COALESCE(u.last_inbound_at, u.last_seen_at, 0) DESC LIMIT ? OFFSET ?"
    ).bind(limit, offset).all();
    return res.results || [];
  } catch (err) {
    console.error("listPrivateChatUsers failed:", err.message);
    return [];
  }
}

export async function listGroupChats(env, options) {
  const opts = options || {};
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  try {
    const res = await env.DB.prepare(
      "SELECT c.chat_id, c.chat_type, c.title, c.enabled, c.mode, " +
      "(SELECT COUNT(*) FROM chat_logs cl WHERE cl.chat_id = c.chat_id) AS log_count, " +
      "(SELECT MAX(cl.created_at) FROM chat_logs cl WHERE cl.chat_id = c.chat_id) AS last_log_at " +
      "FROM chats c WHERE c.chat_type IN ('group','supergroup') " +
      "ORDER BY COALESCE(last_log_at, 0) DESC LIMIT ? OFFSET ?"
    ).bind(limit, offset).all();
    return res.results || [];
  } catch (err) {
    // Fallback when chats table shape differs
    try {
      const res = await env.DB.prepare(
        "SELECT chat_id, chat_type, COUNT(*) AS log_count, MAX(created_at) AS last_log_at " +
        "FROM chat_logs WHERE chat_type IN ('group','supergroup') GROUP BY chat_id, chat_type " +
        "ORDER BY last_log_at DESC LIMIT ? OFFSET ?"
      ).bind(limit, offset).all();
      return res.results || [];
    } catch (e2) {
      console.error("listGroupChats failed:", e2.message);
      return [];
    }
  }
}

export async function listChatMessages(env, chatId, options) {
  const opts = options || {};
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const beforeId = opts.before_id != null ? Number(opts.before_id) : null;
  try {
    if (Number.isFinite(beforeId)) {
      const res = await env.DB.prepare(
        "SELECT id, chat_id, chat_type, message_id, user_id, role, content, media_type, created_at " +
        "FROM chat_logs WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT ?"
      ).bind(chatId, beforeId, limit).all();
      return (res.results || []).reverse();
    }
    const res = await env.DB.prepare(
      "SELECT id, chat_id, chat_type, message_id, user_id, role, content, media_type, created_at " +
      "FROM chat_logs WHERE chat_id = ? ORDER BY id DESC LIMIT ?"
    ).bind(chatId, limit).all();
    return (res.results || []).reverse();
  } catch (err) {
    console.error("listChatMessages failed:", err.message);
    return [];
  }
}

export function detectMediaType(message) {
  if (!message) return null;
  if (message.photo) return "photo";
  if (message.voice) return "voice";
  if (message.audio) return "audio";
  if (message.video) return "video";
  if (message.animation) return "animation";
  if (message.sticker) return "sticker";
  if (message.document) return "document";
  if (message.video_note) return "video_note";
  return null;
}
